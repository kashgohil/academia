/**
 * A ZooKeeper-like coordination service, and the leader-election recipe on top of it.
 *
 * - ZkTree: the replicated data. A tree of znodes; each change gets the next zxid. Ephemeral znodes belong to a
 *   session and go away when it ends. A sequential create appends a 10-digit counter kept by the parent, as in
 *   ZooKeeper (`%010d`). ZkTree is a deterministic StateMachine, so it can run on RaftCluster (the tests do this);
 *   ZooKeeper itself orders the same changes with Zab.
 * - WatchTable: watches are one-time triggers, kept by the server that the client talks to (not replicated).
 * - zkElection: one server (node 0) that applies changes in zxid order, and clients 1..k that run the election
 *   recipe. Each client creates `/election/n_` (ephemeral, sequential) and then either watches the parent
 *   (every change wakes every waiter: the herd effect) or watches only its predecessor, as the recipe says.
 *   The server ends a session when it hears nothing from it for the session timeout.
 */
import { Net } from "../net";
import type { StateMachine } from "../consensus/raft/types";

// ---------------------------------------------------------------- the tree

export type ZkTxn =
  | { op: "create"; path: string; data: string; ephemeral: boolean; sequential: boolean; session: number }
  | { op: "delete"; path: string }
  | { op: "setData"; path: string; data: string }
  | { op: "closeSession"; session: number };

export type ZkEventType = "NodeCreated" | "NodeDeleted" | "NodeDataChanged" | "NodeChildrenChanged";
export interface ZkEvent { type: ZkEventType; path: string }

export interface Znode {
  data: string;
  /** Session id of the owner, or 0 for a persistent znode. */
  ephemeralOwner: number;
  czxid: number;
  mzxid: number;
  /** Data changes. */
  version: number;
  /** Child changes. */
  cversion: number;
  /** The counter for sequential children. */
  seq: number;
}

export interface ZkResult {
  ok: boolean;
  err?: "NodeExists" | "NoNode" | "NotEmpty" | "NoChildrenForEphemerals";
  /** The created path (with its sequence suffix). */
  path?: string;
  zxid: number;
  /** What the change triggers, for the watch table. */
  events: ZkEvent[];
}

export const parentOf = (p: string) => (p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/")));
export const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const seqOf = (name: string) => Number(name.slice(-10));

export class ZkTree implements StateMachine<ZkTxn> {
  zxid = 0;
  nodes = new Map<string, Znode>([["/", { data: "", ephemeralOwner: 0, czxid: 0, mzxid: 0, version: 0, cversion: 0, seq: 0 }]]);

  apply(t: ZkTxn): ZkResult {
    const fail = (err: ZkResult["err"]): ZkResult => ({ ok: false, err, zxid: this.zxid, events: [] });
    if (t.op === "create") {
      const parent = this.nodes.get(parentOf(t.path));
      if (!parent) return fail("NoNode");
      if (parent.ephemeralOwner) return fail("NoChildrenForEphemerals");
      const path = t.sequential ? t.path + String(parent.seq).padStart(10, "0") : t.path;
      if (this.nodes.has(path)) return fail("NodeExists");
      const zxid = ++this.zxid;
      if (t.sequential) parent.seq++;
      parent.cversion++;
      this.nodes.set(path, { data: t.data, ephemeralOwner: t.ephemeral ? t.session : 0, czxid: zxid, mzxid: zxid, version: 0, cversion: 0, seq: 0 });
      return { ok: true, path, zxid, events: [{ type: "NodeCreated", path }, { type: "NodeChildrenChanged", path: parentOf(path) }] };
    }
    if (t.op === "delete") {
      if (!this.nodes.has(t.path)) return fail("NoNode");
      if (this.children(t.path).length) return fail("NotEmpty");
      const zxid = ++this.zxid;
      this.nodes.delete(t.path);
      this.nodes.get(parentOf(t.path))!.cversion++;
      return { ok: true, path: t.path, zxid, events: [{ type: "NodeDeleted", path: t.path }, { type: "NodeChildrenChanged", path: parentOf(t.path) }] };
    }
    if (t.op === "setData") {
      const nd = this.nodes.get(t.path);
      if (!nd) return fail("NoNode");
      nd.mzxid = ++this.zxid;
      nd.data = t.data;
      nd.version++;
      return { ok: true, path: t.path, zxid: this.zxid, events: [{ type: "NodeDataChanged", path: t.path }] };
    }
    // closeSession: one transaction that deletes every ephemeral znode of the session.
    const zxid = ++this.zxid;
    const events: ZkEvent[] = [];
    for (const [path, nd] of [...this.nodes]) {
      if (nd.ephemeralOwner !== t.session) continue;
      this.nodes.delete(path);
      this.nodes.get(parentOf(path))!.cversion++;
      events.push({ type: "NodeDeleted", path }, { type: "NodeChildrenChanged", path: parentOf(path) });
    }
    return { ok: true, zxid, events };
  }

  /** Child names, sorted. */
  children(path: string): string[] {
    const pre = path === "/" ? "/" : path + "/";
    const out: string[] = [];
    for (const p of this.nodes.keys()) if (p !== path && p.startsWith(pre) && !p.slice(pre.length).includes("/")) out.push(p.slice(pre.length));
    return out.sort();
  }

  exists(path: string) {
    return this.nodes.has(path);
  }

  snapshot(): unknown {
    return { zxid: this.zxid, nodes: [...this.nodes].map(([k, v]) => [k, { ...v }]) };
  }

  restore(data: unknown) {
    const d = data as { zxid: number; nodes: [string, Znode][] };
    this.zxid = d.zxid;
    this.nodes = new Map(d.nodes.map(([k, v]) => [k, { ...v }]));
  }
}

// ---------------------------------------------------------------- watches

/** One-time watches of one server. exists and getData set data watches; getChildren sets child watches. */
export class WatchTable {
  data = new Map<string, Set<number>>();
  child = new Map<string, Set<number>>();

  add(kind: "data" | "child", path: string, session: number) {
    const m = kind === "data" ? this.data : this.child;
    if (!m.has(path)) m.set(path, new Set());
    m.get(path)!.add(session);
  }

  /** The (session, event) pairs to send for these events. Each watch fires once and is then removed. */
  trigger(events: ZkEvent[]): [number, ZkEvent][] {
    const out: [number, ZkEvent][] = [];
    const take = (m: Map<string, Set<number>>, ev: ZkEvent) => {
      const s = m.get(ev.path);
      if (!s) return;
      m.delete(ev.path);
      for (const id of s) out.push([id, ev]);
    };
    for (const ev of events) {
      if (ev.type === "NodeChildrenChanged") take(this.child, ev);
      else {
        take(this.data, ev);
        if (ev.type === "NodeDeleted") take(this.child, ev);
      }
    }
    return out;
  }

  /** Drops the watches of a session that ended. */
  forget(session: number) {
    for (const m of [this.data, this.child]) for (const s of m.values()) s.delete(session);
  }
}

// ---------------------------------------------------------------- the election recipe on Net

export type ZkMsg =
  | { k: "ping" }
  | { k: "pong" }
  | { k: "create"; xid: number; path: string; ephemeral: boolean; sequential: boolean }
  | { k: "getChildren"; xid: number; path: string; watch: boolean }
  | { k: "exists"; xid: number; path: string; watch: boolean }
  | { k: "reply"; xid: number; ok: boolean; path?: string; children?: string[]; exists?: boolean }
  | { k: "event"; type: ZkEventType; path: string }
  | { k: "expired" };

export type WatchMode = "herd" | "pred";

export interface ZkAction {
  t: number;
  kind: "kill" | "join";
  /** Client node id (1..max). */
  client: number;
}

export interface ZkElectionCfg {
  seed: number;
  /** Clients that join at the start. */
  clients: number;
  /** Clients that exist in the network (some may join later). */
  maxClients: number;
  mode: WatchMode;
  /** Model input, ms. ZooKeeper allows 2 to 20 times tickTime; with tickTime = 2000 ms the minimum is 4000 ms. */
  sessionTimeout: number;
  actions: ZkAction[];
  /** Run until this time (ms). Default: the last action + timeout + 1000. */
  until?: number;
}

export const ZK_DEFAULT: ZkElectionCfg = { seed: 1, clients: 5, maxClients: 8, mode: "pred", sessionTimeout: 4000, actions: [] };
export const ELECTION = "/election";
/** The server checks for expired sessions this often (ms). Model input. */
export const EXPIRY_TICK = 100;

export interface ZkChange {
  t: number;
  zxid: number;
  what: "create" | "expire";
  /** The znode names created or removed. */
  names: string[];
  session: number;
  /** Watch notifications that this change sent. */
  notified: number;
}

export interface ZkClientView {
  id: number;
  alive: boolean;
  joined: boolean;
  /** Its znode name, once created. */
  name: string | null;
  leader: boolean;
  /** What it watches now: a sibling's name, the parent, or nothing. */
  watching: string | null;
}

export interface ZkElectionRun {
  net: Net<ZkMsg>;
  tree: ZkTree;
  changes: ZkChange[];
  /** Each time a client became the leader. */
  leaders: { t: number; client: number }[];
  clients: ZkClientView[];
  /** All watch notifications sent. */
  notifications: number;
  /** All messages except pings and their replies. */
  requests: number;
  tEnd: number;
}

export function zkElection(cfg: Partial<ZkElectionCfg> = {}): ZkElectionRun {
  const c = { ...ZK_DEFAULT, ...cfg };
  const tree = new ZkTree();
  tree.apply({ op: "create", path: ELECTION, data: "", ephemeral: false, sequential: false, session: 0 });
  const watches = new WatchTable();
  const lastHeard = new Map<number, number>();
  const ended = new Set<number>();
  const changes: ZkChange[] = [];
  const leaders: ZkElectionRun["leaders"] = [];
  let notifications = 0;
  const S = 0;
  const K = c.maxClients;
  const view: ZkClientView[] = Array.from({ length: K }, (_, i) => ({ id: i + 1, alive: true, joined: false, name: null, leader: false, watching: null }));
  const v = (id: number) => view[id - 1]!;
  let xid = 0;
  const pendingXid = new Map<number, string>();

  // ---------------- server
  const commit = (t: ZkTxn, what: ZkChange["what"], session: number) => {
    const r = tree.apply(t);
    if (!r.ok) return r;
    const fired = watches.trigger(r.events);
    for (const [sid, ev] of fired) if (!ended.has(sid)) { net.send(S, sid, { k: "event", type: ev.type, path: ev.path }); notifications++; }
    const names = r.events.filter((e) => e.type === (what === "create" ? "NodeCreated" : "NodeDeleted")).map((e) => nameOf(e.path));
    changes.push({ t: net.now, zxid: r.zxid, what, names, session, notified: fired.filter(([sid]) => !ended.has(sid)).length });
    return r;
  };

  const server = (from: number, p: ZkMsg) => {
    if (ended.has(from)) return void net.send(S, from, { k: "expired" });
    lastHeard.set(from, net.now);
    if (p.k === "ping") return void net.send(S, from, { k: "pong" });
    if (p.k === "create") {
      const r = commit({ op: "create", path: p.path, data: "", ephemeral: p.ephemeral, sequential: p.sequential, session: from }, "create", from);
      return void net.send(S, from, { k: "reply", xid: p.xid, ok: r.ok, path: r.path });
    }
    if (p.k === "getChildren") {
      if (p.watch) watches.add("child", p.path, from);
      return void net.send(S, from, { k: "reply", xid: p.xid, ok: true, children: tree.children(p.path) });
    }
    if (p.k === "exists") {
      const ex = tree.exists(p.path);
      if (p.watch) watches.add("data", p.path, from); // a watch on a missing znode fires when it is created
      return void net.send(S, from, { k: "reply", xid: p.xid, ok: true, exists: ex });
    }
  };

  const expiryTick = () => {
    for (const [sid, t] of lastHeard) {
      if (ended.has(sid) || net.now - t < c.sessionTimeout) continue;
      ended.add(sid);
      watches.forget(sid);
      commit({ op: "closeSession", session: sid }, "expire", sid);
    }
    net.setTimer(S, EXPIRY_TICK, "expiry");
  };

  // ---------------- clients
  const send = (id: number, p: ZkMsg) => net.send(id, S, p);
  const list = (id: number) => {
    const x = ++xid;
    pendingXid.set(x, "list");
    send(id, { k: "getChildren", xid: x, path: ELECTION, watch: c.mode === "herd" });
    v(id).watching = c.mode === "herd" ? ELECTION : null;
  };

  const client = (id: number, p: ZkMsg) => {
    const me = v(id);
    if (!me.alive) return;
    if (p.k === "expired") { me.leader = false; me.watching = null; return; }
    if (p.k === "reply") {
      const what = pendingXid.get(p.xid);
      pendingXid.delete(p.xid);
      if (what === "create" && p.ok) { me.name = nameOf(p.path!); return void list(id); }
      if (what === "list" && p.children && me.name) {
        const kids = p.children;
        const i = kids.indexOf(me.name);
        if (i === 0) {
          if (!me.leader) { me.leader = true; leaders.push({ t: net.now, client: id }); }
          me.watching = null;
          return;
        }
        if (c.mode === "pred" && i > 0) {
          const pred = kids[i - 1]!;
          me.watching = pred;
          const x = ++xid;
          pendingXid.set(x, "exists");
          send(id, { k: "exists", xid: x, path: `${ELECTION}/${pred}`, watch: true });
        }
        return;
      }
      if (what === "exists" && p.exists === false) return void list(id); // the predecessor went away before the watch
      return;
    }
    if (p.k === "event") {
      if (me.leader) return;
      if (c.mode === "pred" && p.type === "NodeDeleted" && me.watching && p.path === `${ELECTION}/${me.watching}`) list(id);
      if (c.mode === "herd" && p.type === "NodeChildrenChanged") list(id);
    }
  };

  const clientTimer = (id: number, tag: string) => {
    if (tag === "ping") {
      send(id, { k: "ping" });
      net.setTimer(id, c.sessionTimeout / 3, "ping");
    } else if (tag === "join") {
      v(id).joined = true;
      const x = ++xid;
      pendingXid.set(x, "create");
      send(id, { k: "create", xid: x, path: `${ELECTION}/n_`, ephemeral: true, sequential: true });
      net.setTimer(id, c.sessionTimeout / 3, "ping");
    } else if (tag.startsWith("act:")) {
      const a = c.actions[Number(tag.slice(4))]!;
      if (a.kind === "kill") { v(a.client).alive = false; v(a.client).leader = false; net.crash(a.client); }
      else if (!v(a.client).joined) clientTimer(a.client, "join");
    }
  };

  const net: Net<ZkMsg> = new Net<ZkMsg>(K + 1, { seed: c.seed, latency: { min: 5, max: 15 }, fifo: true }, {
    onMessage(node, m) {
      if (node === S) server(m.from, m.payload);
      else client(node, m.payload);
    },
    onTimer(node, tag) {
      if (node === S) {
        if (tag === "expiry") expiryTick();
        else clientTimer(node, tag); // scripted actions run on the server's timer queue
      } else clientTimer(node, tag);
    },
  });
  for (let i = 1; i <= c.clients; i++) net.setTimer(i, 2 + 8 * (i - 1), "join");
  c.actions.forEach((a, k) => net.setTimer(S, a.t, `act:${k}`));
  net.setTimer(S, EXPIRY_TICK, "expiry");
  const lastAction = Math.max(0, ...c.actions.map((a) => a.t));
  const until = c.until ?? lastAction + c.sessionTimeout + 1000;
  net.runUntil(until);
  const requests = net.messages.filter((m) => m.payload.k !== "ping" && m.payload.k !== "pong").length;
  return { net, tree, changes, leaders, clients: view, notifications, requests, tEnd: until };
}

/** Live clients that believe they lead. The recipe is correct when this has exactly one entry once things settle. */
export const liveLeaders = (r: ZkElectionRun) => r.clients.filter((x) => x.alive && x.joined && x.leader).map((x) => x.id);

/** The notifications sent by the changes that removed znodes (session expiries). */
export const expiryNotifications = (r: ZkElectionRun) => r.changes.filter((ch) => ch.what === "expire").map((ch) => ch.notified);
