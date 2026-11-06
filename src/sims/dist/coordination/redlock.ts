/**
 * Redlock on the shared Net: five independent Redis-like nodes and two clients.
 *
 * A node keeps keys with an expiry time on its own clock: `SET key value NX PX ttl` sets the key only if it is absent
 * (or expired). A client takes the lock as the Redis docs describe it: read the time, send SET to all five in
 * parallel, and count the successes. It holds the lock if it got at least 3 and the time spent is less than the TTL.
 * The validity is TTL − elapsed − drift, where drift = ⌊0.01 · TTL⌋ + 2 ms, as in antirez's redlock-rb.
 * If it fails, it deletes its value on every node.
 *
 * The learner is the adversary: cut some links while a client acquires, jump node C's clock forward, restart node C
 * without persistence, or pause client 1 after it checked its lock. The run reports when both clients act under the lock.
 */
import { Net, type Message, type NodeId } from "../net";

export type RedisMsg =
  | { k: "set"; key: string; val: string; ttl: number; req: number }
  | { k: "del"; key: string; val: string }
  | { k: "res"; req: number; ok: boolean };

export interface RedlockCfg {
  seed: number;
  ttl: number;
  /** Client 1 cannot reach nodes D and E while it acquires (0 to 120 ms). */
  cut1: boolean;
  /** Client 2 cannot reach nodes A and B from 120 ms on. */
  cut2: boolean;
  /** Node C's clock jumps forward by this many ms at 100 ms. */
  jumpC: number;
  /** Node C crashes at 130 ms and restarts with no data: at 140 ms, or one TTL later with a delayed restart. */
  crashC: "none" | "restart" | "delayed";
  /** Client 1 stops for this many ms right after its check at its 2nd step of work. */
  pause1: number;
}

export const REDLOCK_DEFAULT: RedlockCfg = { seed: 2, ttl: 1000, cut1: true, cut2: true, jumpC: 0, crashC: "none", pause1: 0 };

export const REDIS_NODES = 5;
export const C1 = 5, C2 = 6;
/** Redlock's per-node timeout for one SET, and the reference drift allowance. */
export const SET_TIMEOUT = 50;
export const redlockDrift = (ttl: number) => Math.floor(ttl * 0.01) + 2;
/** Client 1 works for this long in steps of STEP ms; client 2 works for WORK2 ms. */
const WORK1 = 800, WORK2 = 300, STEP = 100, C2_START = 150;

export interface KeySpan {
  node: NodeId;
  client: NodeId;
  from: number;
  to: number;
  why: "expired" | "deleted" | "crashed" | "end";
}

export interface Attempt {
  client: NodeId;
  start: number;
  end: number;
  got: number;
  ok: boolean;
  /** Validity in ms, by the client's clock. */
  validity: number;
}

export interface RedlockRun {
  net: Net<RedisMsg>;
  attempts: Attempt[];
  keys: KeySpan[];
  /** Real time spans in which each client acts as the lock holder. */
  acting: { client: NodeId; from: number; to: number }[];
  /** When both clients acted under the lock at once. */
  overlap: { from: number; to: number } | null;
  pause: { from: number; to: number } | null;
  tEnd: number;
}

export function redlockRun(cfg: Partial<RedlockCfg> = {}): RedlockRun {
  const c = { ...REDLOCK_DEFAULT, ...cfg };
  const KEY = "lock";
  const store: Map<string, { val: string; exp: number; span: KeySpan }>[] = Array.from({ length: REDIS_NODES }, () => new Map());
  const keys: KeySpan[] = [];
  const attempts: Attempt[] = [];
  const acting: RedlockRun["acting"] = [];
  let req = 0;
  let pause: RedlockRun["pause"] = null;
  const pending: (() => void)[] = [];

  const expire = (i: NodeId) => {
    const e = store[i]!.get(KEY);
    if (e && net.clock(i) >= e.exp) {
      e.span.to = net.now;
      e.span.why = "expired";
      store[i]!.delete(KEY);
    }
  };

  // Client state
  type Cl = { val: string; t1: number; got: number; replies: number; req0: number; holding: boolean; until: number; acting: { client: NodeId; from: number; to: number } | null; done: boolean; steps: number; timer: number; asking: boolean };
  const cl = new Map<NodeId, Cl>();
  for (const id of [C1, C2]) cl.set(id, { val: "", t1: 0, got: 0, replies: 0, req0: 0, holding: false, until: 0, acting: null, done: false, steps: 0, timer: 0, asking: false });

  const paused = (id: NodeId) => id === C1 && pause !== null && net.now >= pause.from && net.now < pause.to;

  const acquire = (id: NodeId) => {
    const s = cl.get(id)!;
    s.val = `${id === C1 ? "c1" : "c2"}-${Math.floor(net.random() * 1e6)}`;
    s.t1 = net.clock(id);
    s.got = 0;
    s.replies = 0;
    s.req0 = req + 1;
    s.asking = true;
    for (let i = 0; i < REDIS_NODES; i++) net.send(id, i, { k: "set", key: KEY, val: s.val, ttl: c.ttl, req: ++req });
    s.timer = net.setTimer(id, SET_TIMEOUT, "decide");
  };

  const decide = (id: NodeId) => {
    const s = cl.get(id)!;
    net.cancelTimer(s.timer);
    if (!s.asking) return;
    s.asking = false;
    const elapsed = net.clock(id) - s.t1;
    const validity = c.ttl - elapsed - redlockDrift(c.ttl);
    const ok = s.got >= 3 && validity > 0;
    attempts.push({ client: id, start: net.now - elapsed / (1 + net.drift[id]!), end: net.now, got: s.got, ok, validity });
    if (ok) {
      s.holding = true;
      s.until = s.t1 + validity;
      s.acting = { client: id, from: net.now, to: net.now };
      acting.push(s.acting);
      s.steps = 0;
      net.setTimer(id, STEP, "work");
    } else {
      unlock(id);
      net.setTimer(id, 100 + net.random() * 100, "retry");
    }
  };

  const unlock = (id: NodeId) => {
    const s = cl.get(id)!;
    for (let i = 0; i < REDIS_NODES; i++) net.send(id, i, { k: "del", key: KEY, val: s.val });
  };

  const stop = (id: NodeId) => {
    const s = cl.get(id)!;
    if (s.acting) s.acting.to = net.now;
    s.acting = null;
    s.holding = false;
    s.done = true;
    unlock(id);
  };

  const clientTimer = (id: NodeId, tag: string) => {
    const s = cl.get(id)!;
    if (s.done) return;
    if (tag === "start" || tag === "retry") acquire(id);
    else if (tag === "decide") decide(id);
    else if (tag === "work" && s.holding) {
      s.steps++;
      const total = id === C1 ? WORK1 : WORK2;
      // Check the lock by the client's own clock before each step of work.
      if (net.clock(id) >= s.until) return void stop(id);
      if (s.acting) s.acting.to = net.now;
      if (s.steps * STEP >= total) return void stop(id);
      if (id === C1 && s.steps === 2 && c.pause1 > 0 && !pause) {
        // The GC stops the client after its check. On waking, it does the step it checked for.
        pause = { from: net.now + 0.5, to: net.now + 0.5 + c.pause1 };
        net.setTimer(C1, pause.to - net.now, "wake");
        pending.push(() => { if (s.acting) s.acting.to = net.now; });
      }
      net.setTimer(id, STEP, "work");
    }
  };

  // The adversary's script, run by timers on node C2 (which never crashes).
  const script: [number, () => void][] = [];
  if (c.cut1) script.push([0, () => net.partition([[0, 1, 2, C1], [3, 4], [C2]])]);
  if (c.cut2) script.push([120, () => net.partition([[2, 3, 4, C2], [0, 1], [C1]])]);
  else if (c.cut1) script.push([120, () => net.heal()]);
  if (c.jumpC) script.push([100, () => { net.offset[2] = net.offset[2]! + c.jumpC; }]);
  if (c.crashC !== "none") {
    script.push([130, () => {
      const e = store[2]!.get(KEY);
      if (e) { e.span.to = net.now; e.span.why = "crashed"; store[2]!.delete(KEY); }
      net.crash(2);
    }]);
    script.push([c.crashC === "restart" ? 140 : 130 + c.ttl, () => net.recover(2)]);
  }

  const net: Net<RedisMsg> = new Net<RedisMsg>(7, { seed: c.seed, latency: { min: 5, max: 15 } }, {
    onMessage(node, m: Message<RedisMsg>) {
      const p = m.payload;
      if (node < REDIS_NODES) {
        expire(node);
        const st = store[node]!;
        if (p.k === "set") {
          const ok = !st.has(p.key);
          if (ok) {
            const span: KeySpan = { node, client: m.from, from: net.now, to: Infinity, why: "end" };
            keys.push(span);
            st.set(p.key, { val: p.val, exp: net.clock(node) + p.ttl, span });
          }
          net.send(node, m.from, { k: "res", req: p.req, ok });
        } else if (p.k === "del") {
          const e = st.get(p.key);
          if (e && e.val === p.val) {
            e.span.to = net.now;
            e.span.why = "deleted";
            st.delete(p.key);
          }
        }
        return;
      }
      const run = () => {
        const s = cl.get(node)!;
        if (p.k !== "res" || p.req < s.req0 || !s.asking || s.done) return;
        s.replies++;
        if (p.ok) s.got++;
        if (s.replies === REDIS_NODES) decide(node);
      };
      if (paused(node)) pending.push(run);
      else run();
    },
    onTimer(node, tag) {
      if (tag.startsWith("script:")) return void script[Number(tag.slice(7))]![1]();
      if (node < REDIS_NODES) {
        if (tag === "tick") { expire(node); net.setTimer(node, 2, "tick"); }
        return;
      }
      if (node === C1 && tag === "wake") {
        const q = pending.splice(0);
        for (const f of q) f();
        return;
      }
      if (node === C1 && pause && paused(node)) return void pending.push(() => clientTimer(node, tag));
      clientTimer(node, tag);
    },
    onRecover(node) {
      if (node < REDIS_NODES) store[node]!.clear(); // no persistence: the restarted node has no keys
      net.setTimer(node, 2, "tick");
    },
  });

  script.forEach(([t], k) => net.setTimer(C2, t, `script:${k}`));
  for (let i = 0; i < REDIS_NODES; i++) net.setTimer(i, 2, "tick");
  net.setTimer(C1, 0, "start");
  net.setTimer(C2, C2_START, "start");
  net.runUntil(4000);
  for (const k of keys) if (k.to === Infinity) k.to = net.now;
  for (const s of cl.values()) if (s.acting) s.acting.to = net.now;

  const a1 = acting.filter((a) => a.client === C1), a2 = acting.filter((a) => a.client === C2);
  let overlap: RedlockRun["overlap"] = null;
  for (const x of a1) for (const y of a2) {
    const from = Math.max(x.from, y.from), to = Math.min(x.to, y.to);
    if (to > from && !overlap) overlap = { from, to };
  }
  const pz = pause as RedlockRun["pause"]; // assigned inside handlers, so TypeScript cannot see it
  const last = Math.max(...acting.map((a) => a.to), ...attempts.map((a) => a.end), pz?.to ?? 0);
  return { net, attempts, keys, acting, overlap, pause: pz, tEnd: Math.ceil((last + 100) / 100) * 100 };
}
