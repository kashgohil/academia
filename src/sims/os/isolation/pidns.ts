/**
 * PID namespaces. As in the kernel's struct pid, one process has one PID number per namespace,
 * from its own namespace up to the root. A namespace sees itself and its descendants, and never an ancestor.
 */
/** MAX_PID_NS_LEVEL: nesting limit since Linux 3.7. */
export const MAX_PID_NS_LEVEL = 32;
/** PROC_PID_INIT_INO: the inode number that /proc/<pid>/ns/pid shows for the initial namespace. */
export const PROC_PID_INIT_INO = 0xeffffffc;

export interface PidNs { id: number; parent: number | null; level: number; ino: number; next: number; init: number | null; /** PID 1 has died: no new process can enter. */ dead: boolean }
export interface Proc { id: number; name: string; parent: number | null; ns: number; /** PID in each namespace, index = level. */ pids: number[]; alive: boolean; /** Namespace for the next child, after unshare or setns. */ forChildren: number }

export class PidWorld {
  readonly spaces = new Map<number, PidNs>();
  readonly procs = new Map<number, Proc>();
  private nextId = 1;
  private nextNs = 1;
  private nextIno = PROC_PID_INIT_INO + 0x1000;
  readonly rootNs: number;
  readonly log: string[] = [];

  constructor() {
    this.rootNs = this.addNs(null);
    this.spawn(null, this.rootNs, "systemd");
  }

  private addNs(parent: number | null): number {
    const level = parent === null ? 0 : this.spaces.get(parent)!.level + 1;
    const id = this.nextNs++;
    this.spaces.set(id, { id, parent, level, ino: parent === null ? PROC_PID_INIT_INO : this.nextIno++, next: 1, init: null, dead: false });
    return id;
  }

  /** The chain of namespaces from the root down to `ns`. */
  chain(ns: number): PidNs[] {
    const out: PidNs[] = [];
    for (let n: number | null = ns; n !== null; n = this.spaces.get(n)!.parent) out.unshift(this.spaces.get(n)!);
    return out;
  }

  private spawn(parent: number | null, ns: number, name: string): number {
    const chain = this.chain(ns);
    const id = this.nextId++;
    const pids = chain.map((s) => s.next++);
    this.procs.set(id, { id, name, parent, ns, pids, alive: true, forChildren: ns });
    const leaf = chain[chain.length - 1]!;
    if (leaf.init === null) leaf.init = id;
    return id;
  }

  /** clone or fork. With newPid the child starts a new namespace, and it is PID 1 there. */
  clone(parent: number, name: string, opts: { newPid?: boolean } = {}): number {
    const p = this.must(parent);
    let ns = p.forChildren;
    if (opts.newPid) {
      if (this.spaces.get(ns)!.level + 1 >= MAX_PID_NS_LEVEL) throw new Error("ENOSPC");
      ns = this.addNs(ns);
    }
    if (this.spaces.get(ns)!.dead) throw new Error("ENOMEM");
    const id = this.spawn(parent, ns, name);
    this.log.push(`${p.name} cloned ${name}${opts.newPid ? " in a new PID namespace, where it is PID 1" : ""}`);
    return id;
  }

  /** unshare(CLONE_NEWPID): the caller stays where it is. Its next child is PID 1 of the new namespace. */
  unsharePid(proc: number): number {
    const p = this.must(proc);
    const ns = this.addNs(p.forChildren);
    p.forChildren = ns;
    return ns;
  }

  private must(id: number): Proc {
    const p = this.procs.get(id);
    if (!p || !p.alive) throw new Error("ESRCH");
    return p;
  }

  /** The PID of `proc` as seen from `ns`, or null if `ns` cannot see it. */
  pidIn(proc: number, ns: number): number | null {
    const p = this.procs.get(proc);
    if (!p) return null;
    const s = this.spaces.get(ns)!;
    const chain = this.chain(p.ns);
    return chain[s.level]?.id === ns ? p.pids[s.level]! : null;
  }

  /** find_pid_ns: the process that has this PID in this namespace. */
  resolve(ns: number, pid: number): number | null {
    for (const p of this.procs.values()) if (p.alive && this.pidIn(p.id, ns) === pid) return p.id;
    return null;
  }

  /** What `ps` shows when /proc belongs to this namespace. */
  visibleFrom(ns: number): Proc[] {
    return [...this.procs.values()].filter((p) => p.alive && this.pidIn(p.id, ns) !== null).sort((a, b) => this.pidIn(a.id, ns)! - this.pidIn(b.id, ns)!);
  }

  /** getppid: 0 when the parent is outside the caller's namespace. */
  getppid(proc: number): number {
    const p = this.must(proc);
    return p.parent === null ? 0 : this.pidIn(p.parent, p.ns) ?? 0;
  }

  /** Signals to PID 1 of a namespace. From inside, only signals with a handler arrive. From an ancestor, SIGKILL and SIGSTOP also arrive. */
  signalDelivered(sender: number, target: number, sig: "SIGTERM" | "SIGKILL" | "SIGSTOP", hasHandler: boolean): boolean {
    const t = this.must(target), s = this.must(sender);
    if (this.pidIn(target, s.ns) === null) return false; // the sender cannot name it
    const isInit = this.spaces.get(t.ns)!.init === target;
    if (!isInit) return true;
    const fromInside = s.ns === t.ns;
    if (sig === "SIGKILL" || sig === "SIGSTOP") return !fromInside;
    return hasHandler;
  }

  /** The process exits. Orphans go to PID 1 of the namespace. If PID 1 exits, the kernel kills every process in the namespace and in its descendants. */
  exit(proc: number): number[] {
    const p = this.must(proc);
    const ns = this.spaces.get(p.ns)!;
    const died = [proc];
    p.alive = false;
    if (ns.init === proc && p.ns !== this.rootNs) {
      ns.dead = true;
      for (const q of this.procs.values()) {
        if (q.alive && this.pidIn(q.id, p.ns) !== null) { q.alive = false; died.push(q.id); }
      }
      for (const s of this.spaces.values()) if (this.chain(s.id).some((x) => x.id === p.ns)) s.dead = true;
      this.log.push(`PID 1 of the namespace died: the kernel sent SIGKILL to ${died.length - 1} other process(es)`);
    } else {
      const reaper = ns.init;
      for (const q of this.procs.values()) if (q.alive && q.parent === proc) q.parent = reaper;
    }
    return died;
  }
}

/** The eight namespace types: name in /proc/<pid>/ns, clone flag and value, what it isolates, and the first Linux version. */
export const NAMESPACE_TYPES = [
  { name: "mnt", flag: "CLONE_NEWNS", value: 0x00020000, isolates: "Mount tree", since: "2.4.19" },
  { name: "uts", flag: "CLONE_NEWUTS", value: 0x04000000, isolates: "Host name, domain name", since: "2.6.19" },
  { name: "ipc", flag: "CLONE_NEWIPC", value: 0x08000000, isolates: "System V IPC, POSIX queues", since: "2.6.19" },
  { name: "pid", flag: "CLONE_NEWPID", value: 0x20000000, isolates: "Process IDs", since: "2.6.24" },
  { name: "net", flag: "CLONE_NEWNET", value: 0x40000000, isolates: "Interfaces, routes, ports, firewall", since: "2.6.29" },
  { name: "user", flag: "CLONE_NEWUSER", value: 0x10000000, isolates: "UIDs, GIDs, capabilities", since: "3.8" },
  { name: "cgroup", flag: "CLONE_NEWCGROUP", value: 0x02000000, isolates: "The view of the cgroup tree", since: "4.6" },
  { name: "time", flag: "CLONE_NEWTIME", value: 0x00000080, isolates: "CLOCK_MONOTONIC, CLOCK_BOOTTIME offsets", since: "5.6" },
] as const;

export type Propagation = "shared" | "slave" | "private" | "unbindable";
/** Does a mount in the first copy appear in the second copy? And in the other direction? */
export function propagates(type: Propagation): { originToCopy: boolean; copyToOrigin: boolean; canBindMount: boolean } {
  return {
    originToCopy: type === "shared" || type === "slave",
    copyToOrigin: type === "shared",
    canBindMount: type !== "unbindable",
  };
}
