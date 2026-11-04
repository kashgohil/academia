/**
 * The VFS path walk: a mount tree of file systems, a dentry cache with negative entries and LRU eviction, and a walker
 * that follows the kernel's order. For each component it checks search permission on the parent (may_lookup), looks in
 * the dcache (lookup_fast), goes to the file system on a miss (lookup_slow), crosses mounts, and follows symlinks.
 *
 * The walk starts in RCU-walk mode, which takes no references. It drops to ref-walk (try_to_unlazy) when it must block,
 * which is the case on every dcache miss.
 */
import { MAX_SYMLINKS } from "./inodefs";
import { HDDS, SSD_NVME, hddAccess, ssdReadUs } from "../../db/storage/disk";

export type VKind = "dir" | "file" | "symlink";

export interface VNode {
  id: number;
  name: string;
  kind: VKind;
  mode: number;
  uid: number;
  gid: number;
  fs: string;
  parent: VNode | null;
  children: Map<string, VNode> | null;
  target: string | null;
}

export interface Mount { id: number; fs: string; root: VNode; at: VNode | null; parentMount: Mount | null }
export interface Cred { name: string; uid: number; gids: number[] }

export const ROOT_CRED: Cred = { name: "root", uid: 0, gids: [0] };
export const USER_CRED: Cred = { name: "kash", uid: 1000, gids: [1000] };

/** The number of symlinks a single lookup may follow. */
export { MAX_SYMLINKS };
/** Linux limits (include/uapi/linux/limits.h). */
export const NAME_MAX = 255;
export const PATH_MAX = 4096;

let nextNode = 1;

export function dir(name: string, fs: string, kids: VNode[] = [], mode = 0o755, uid = 0, gid = 0): VNode {
  const n: VNode = { id: nextNode++, name, kind: "dir", mode, uid, gid, fs, parent: null, children: new Map(), target: null };
  for (const k of kids) { k.parent = n; n.children!.set(k.name, k); }
  return n;
}
export const file = (name: string, fs: string, mode = 0o644, uid = 0, gid = 0): VNode =>
  ({ id: nextNode++, name, kind: "file", mode, uid, gid, fs, parent: null, children: null, target: null });
export const symlink = (name: string, fs: string, target: string): VNode =>
  ({ id: nextNode++, name, kind: "symlink", mode: 0o777, uid: 0, gid: 0, fs, parent: null, children: null, target });

export class Namespace {
  readonly mounts: Mount[] = [];
  constructor(root: VNode) { this.mounts.push({ id: 1, fs: root.fs, root, at: null, parentMount: null }); }
  get rootMount() { return this.mounts[0]!; }
  /** Puts `root` over the directory at `path`. The directory's own contents are hidden, not removed. */
  mount(path: string, root: VNode) {
    let m = this.rootMount;
    let n = m.root;
    for (const part of path.split("/").filter(Boolean)) {
      n = n.children!.get(part)!;
      const over = this.mountAt(m, n);
      if (over) { m = over; n = over.root; }
    }
    const made: Mount = { id: this.mounts.length + 1, fs: root.fs, root, at: n, parentMount: m };
    this.mounts.push(made);
    return made;
  }
  /** __lookup_mnt: the mount, if any, whose mount point is `n` in the mount `m`. */
  mountAt(m: Mount, n: VNode): Mount | undefined {
    return this.mounts.slice().reverse().find((x) => x.at === n && x.parentMount === m);
  }
}

/** The namespace of the path walk demo. Nodes are made fresh, so demos and tests do not share state. */
export function demoNamespace(): Namespace {
  const R = "ext4";
  const root = dir("/", R, [
    dir("etc", R, [file("passwd", R), dir("ssl", R, [file("cert.pem", R)])]),
    dir("home", R, [dir("kash", R, [file("notes.txt", R, 0o644, 1000, 1000), symlink("latest", R, "notes.txt"), symlink("data", R, "/mnt/data")], 0o755, 1000, 1000)]),
    dir("root", R, [file("secret", R, 0o600)], 0o700),
    dir("usr", R, [dir("bin", R, [file("ls", R, 0o755)])]),
    symlink("bin", R, "usr/bin"),
    dir("mnt", R, [dir("data", R, [file("hidden-by-mount", R)])]),
    dir("tmp", R, [], 0o1777),
    dir("loop", R, [symlink("a", R, "b"), symlink("b", R, "a")]),
  ]);
  const ns = new Namespace(root);
  const D = "xfs";
  ns.mount("/mnt/data", dir("/", D, [dir("logs", D, [file("app.log", D)]), symlink("etc", D, "../../etc")]));
  ns.mount("/tmp", dir("/", "tmpfs", [file("sock", "tmpfs")], 0o1777));
  return ns;
}

export interface DcacheEntry { parent: number; name: string; node: VNode | null }

/** A dentry cache keyed by (parent, name). A null node is a negative dentry: a cached "no such file". */
export class Dcache {
  private m = new Map<string, DcacheEntry>();
  hits = 0;
  misses = 0;
  negativeHits = 0;
  constructor(readonly capacity = 1024) {}
  private key(parent: VNode, name: string) { return `${parent.id}/${name}`; }
  /** Returns the entry, refreshed in LRU order, or undefined on a miss. */
  lookup(parent: VNode, name: string): DcacheEntry | undefined {
    const k = this.key(parent, name);
    const e = this.m.get(k);
    if (!e) { this.misses++; return undefined; }
    this.m.delete(k);
    this.m.set(k, e);
    if (e.node) this.hits++; else this.negativeHits++;
    return e;
  }
  insert(parent: VNode, name: string, node: VNode | null) {
    const k = this.key(parent, name);
    this.m.delete(k);
    this.m.set(k, { parent: parent.id, name, node });
    while (this.m.size > this.capacity) this.m.delete(this.m.keys().next().value!);
  }
  /** Drops an entry: what d_delete and d_invalidate do when a file changes. */
  invalidate(parent: VNode, name: string) { this.m.delete(this.key(parent, name)); }
  /** echo 2 > /proc/sys/vm/drop_caches, for this model. */
  clear() { this.m.clear(); }
  get size() { return this.m.size; }
  get entries() { return [...this.m.values()]; }
}

export type StepKind = "perm" | "hit" | "negative" | "miss" | "dirread" | "unlazy" | "mount" | "symlink" | "dotdot" | "done" | "error";

export interface WalkStep {
  kind: StepKind;
  component: string;
  say: string;
  /** Where the walk stands after this step. */
  fs: string;
  at: string;
  mode: "rcu" | "ref";
  ok?: boolean;
}

export interface WalkResult {
  steps: WalkStep[];
  error: "ENOENT" | "EACCES" | "ENOTDIR" | "ELOOP" | null;
  node: VNode | null;
  checks: number;
  hits: number;
  negative: number;
  misses: number;
  mounts: number;
  links: number;
  endMode: "rcu" | "ref";
}

const octal = (m: number) => m.toString(8).padStart(4, "0");

/** Which permission class applies: the first match wins, so an owner without the bit is denied even if others have it. */
export function searchAllowed(n: VNode, c: Cred): { ok: boolean; rule: string } {
  if (c.uid === 0) return { ok: true, rule: "root: capability CAP_DAC_READ_SEARCH" };
  if (c.uid === n.uid) return { ok: (n.mode & 0o100) !== 0, rule: `owner bit of ${octal(n.mode)}` };
  if (c.gids.includes(n.gid)) return { ok: (n.mode & 0o010) !== 0, rule: `group bit of ${octal(n.mode)}` };
  return { ok: (n.mode & 0o001) !== 0, rule: `other bit of ${octal(n.mode)}` };
}

export function pathOf(ns: Namespace, m: Mount, n: VNode): string {
  const parts: string[] = [];
  let mm = m, x: VNode | null = n;
  while (x) {
    if (x === mm.root) {
      if (!mm.at) break;
      x = mm.at;
      mm = mm.parentMount!;
      continue;
    }
    parts.unshift(x.name);
    x = x.parent;
  }
  void ns;
  return "/" + parts.join("/");
}

export interface WalkOpts { cred?: Cred; follow?: boolean; dcache?: Dcache | null }

/** One path lookup, the way link_path_walk does it. It fills the dcache as a side effect. */
export function walkPath(ns: Namespace, path: string, o: WalkOpts = {}): WalkResult {
  const cred = o.cred ?? USER_CRED;
  const follow = o.follow ?? true;
  const dc = o.dcache ?? null;
  const steps: WalkStep[] = [];
  let mode: "rcu" | "ref" = "rcu";
  let m = ns.rootMount;
  let cur = m.root;
  let links = 0;
  const r: WalkResult = { steps, error: null, node: null, checks: 0, hits: 0, negative: 0, misses: 0, mounts: 0, links: 0, endMode: "rcu" };
  const push = (kind: StepKind, component: string, say: string, ok?: boolean) =>
    steps.push({ kind, component, say, fs: m.fs, at: pathOf(ns, m, cur), mode, ok });
  const fail = (e: NonNullable<WalkResult["error"]>, component: string, say: string) => {
    r.error = e;
    push("error", component, say, false);
    r.endMode = mode;
    r.links = links;
    return r;
  };
  const crossMounts = (component: string) => {
    for (let over = ns.mountAt(m, cur); over; over = ns.mountAt(m, cur)) {
      m = over;
      cur = over.root;
      r.mounts++;
      push("mount", component, `The dentry is a mount point. __lookup_mnt finds a mount, and the walk moves to the root of ${over.fs}.`);
    }
  };

  // A stack of pending components. A symlink pushes its target onto the front.
  const pending: { name: string; last: boolean }[] = [];
  const pushPath = (p: string, last: boolean) => {
    const parts = p.split("/").filter((x) => x && x !== ".");
    pending.unshift(...parts.map((name, i) => ({ name, last: last && i === parts.length - 1 })));
  };
  pushPath(path, true);

  while (pending.length) {
    const { name, last } = pending.shift()!;
    if (cur.kind !== "dir") return fail("ENOTDIR", name, `${cur.name} is not a directory, so the walk cannot look up ${name} in it.`);

    const perm = searchAllowed(cur, cred);
    r.checks++;
    push("perm", name, `may_lookup: ${cred.name} needs search (x) on ${pathOf(ns, m, cur)}. Rule: ${perm.rule}. ${perm.ok ? "Allowed." : "Denied."}`, perm.ok);
    if (!perm.ok) return fail("EACCES", name, `The walk stops with EACCES at ${pathOf(ns, m, cur)}. It never looks at ${name}.`);

    if (name === "..") {
      while (cur === m.root && m.at) {
        cur = m.at;
        m = m.parentMount!;
        r.mounts++;
      }
      if (cur.parent && cur !== m.root) cur = cur.parent;
      push("dotdot", name, `follow_dotdot moves to ${pathOf(ns, m, cur)}. At the root of a mount it first steps back to the mount point.`);
      continue;
    }

    let child: VNode | null;
    const e = dc?.lookup(cur, name);
    if (e) {
      child = e.node;
      if (child) {
        r.hits++;
        push("hit", name, `lookup_fast: the dcache has (${cur.name}, ${name}). ${mode === "rcu" ? "RCU-walk takes no reference and no lock." : "Ref-walk takes a reference with dget."}`);
      } else {
        r.negative++;
        push("negative", name, `lookup_fast: a negative dentry says that ${name} does not exist. The file system is not asked.`);
        return fail("ENOENT", name, "The result is ENOENT, with no disk access.");
      }
    } else {
      r.misses++;
      if (mode === "rcu") {
        mode = "ref";
        push("unlazy", name, "The dcache has no entry, and a file system read can block. try_to_unlazy takes real references and leaves RCU-walk.");
      } else {
        push("miss", name, "The dcache has no entry. The walk is already in ref-walk.");
      }
      child = cur.children!.get(name) ?? null;
      dc?.insert(cur, name, child);
      push("dirread", name, `lookup_slow: the inode lock is taken, and ${cur.fs} searches the directory. ${child ? "It finds the entry and adds a dentry." : "It finds nothing and adds a negative dentry."}`);
      if (!child) return fail("ENOENT", name, "The result is ENOENT. The next lookup of this name hits the negative dentry.");
    }

    cur = child;
    crossMounts(name);

    if (cur.kind === "symlink" && (follow || !last)) {
      if (links >= MAX_SYMLINKS) return fail("ELOOP", name, `The walk has followed ${MAX_SYMLINKS} symlinks, so it stops with ELOOP.`);
      links++;
      const target = cur.target!;
      const lnk = cur;
      cur = lnk.parent ?? cur;
      if (target.startsWith("/")) { m = ns.rootMount; cur = m.root; }
      pushPath(target, last);
      push("symlink", name, `Symlink number ${links}: ${name} points to ${target}. ${target.startsWith("/") ? "The target is absolute, so the walk restarts at the root." : `The walk continues from ${pathOf(ns, m, cur)}.`}`);
    }
  }

  r.node = cur;
  r.links = links;
  r.endMode = mode;
  push("done", cur.name, `The walk ends on ${pathOf(ns, m, cur)} in ${m.fs}. stat needs no permission on the file itself.`, true);
  return r;
}

// ------------------------------------------------------------------------------------------- the cost model

/** Model inputs for the cost of stat(). None of them is a measurement of a real kernel. */
export const STAT_COST_INPUTS = {
  /** Entry, exit and copying the path string, in ns. */
  syscallNs: 200,
  /** One component through the dcache in RCU-walk, permission check included, in ns. */
  hitNs: 40,
  /** One directory search in cached directory blocks, and building a dentry, in ns. */
  searchNs: 2000,
  /** The share of directory searches that must read a block from the device. */
  blockMissRate: 0.01,
};

export type StatDevice = "nvme" | "hdd";
/** The read time per block comes from the disk models of the databases track. */
export function deviceReadNs(d: StatDevice): number {
  return d === "nvme" ? ssdReadUs(SSD_NVME, 4096) * 1e3 : hddAccess(HDDS["7200"], 4096, "random").total * 1e6;
}

export interface StatCostOpts { depth: number; hitRate: number; device?: StatDevice; blockMissRate?: number; searchNs?: number; hitNs?: number; syscallNs?: number }

/** Mean cost of one stat with a dcache: each component hits at hitRate, and a miss pays a search. */
export function statCost(o: StatCostOpts) {
  const syscallNs = o.syscallNs ?? STAT_COST_INPUTS.syscallNs;
  const hitNs = o.hitNs ?? STAT_COST_INPUTS.hitNs;
  const searchNs = o.searchNs ?? STAT_COST_INPUTS.searchNs;
  const miss = o.blockMissRate ?? STAT_COST_INPUTS.blockMissRate;
  const readNs = deviceReadNs(o.device ?? "nvme");
  const slow = searchNs + miss * readNs;
  const withDcache = syscallNs + o.depth * (o.hitRate * hitNs + (1 - o.hitRate) * slow);
  const without = syscallNs + o.depth * slow;
  return { withDcache, without, ratio: without / withDcache, slowNs: slow, readNs };
}

/** The rate of stat calls that one core can do at this cost. */
export const statsPerSecond = (ns: number) => 1e9 / ns;
