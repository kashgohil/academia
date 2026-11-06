/**
 * A tiny model for the FLP proof: three processes, binary inputs, asynchronous messages, at most one crash.
 *
 * The protocol is Ben-Or's protocol with the coin replaced by a fixed rule, so that it is deterministic:
 *   round r, phase 1: send x. With your own x and the first other x to arrive: if they match, propose it, else propose ⊥.
 *   round r, phase 2: send the proposal. With your own and the first other to arrive:
 *     two equal proposals v: decide v.  one proposal v: x = v.  no proposal: x = r mod 2 (the fixed "coin").
 * It is safe: two processes never decide differently. It also decides when one process is dead from the start.
 * But FLP says that some fair run never decides, and this model lets a learner find one.
 *
 * A configuration is the state of each process plus the messages in flight. An event delivers one message to a
 * process that is in the round and phase of the message. A message for a phase that its receiver has left is
 * dropped from the configuration at once: the receiver would ignore it. The valence of a configuration is the set of
 * values that some process can still decide. An exhaustive search over every schedule computes it, up to a horizon of
 * rounds that slides with the run.
 */

export type Bit = 0 | 1;
export type Prop = Bit | null;

export interface VProc {
  r: number;
  ph: 1 | 2;
  /** The current estimate. */
  x: Bit;
  /** What this process sent in the current phase: x in phase 1, its proposal in phase 2. */
  mine: Prop;
  dec: Bit | null;
  /** Past the search horizon: it takes no more steps. */
  done: boolean;
}

export interface VMsg {
  id: number;
  from: number;
  to: number;
  r: number;
  ph: 1 | 2;
  v: Prop;
}

export interface VConfig {
  p: VProc[];
  m: VMsg[];
  nextId: number;
}

/** Bit mask of reachable decisions: 1 = 0 is reachable, 2 = 1 is reachable, 3 = bivalent, 0 = none. */
export type Valence = 0 | 1 | 2 | 3;

export const N = 3;
/** The fixed rule that replaces the coin in round r. */
export const coin = (r: number): Bit => (r % 2) as Bit;

export function initial(inputs: Bit[]): VConfig {
  const c: VConfig = { p: inputs.map((x) => ({ r: 1, ph: 1, x, mine: x, dec: null, done: false })), m: [], nextId: 1 };
  for (let i = 0; i < N; i++) broadcast(c, i);
  return c;
}

function broadcast(c: VConfig, from: number) {
  const p = c.p[from]!;
  for (let to = 0; to < N; to++) if (to !== from) c.m.push({ id: c.nextId++, from, to, r: p.r, ph: p.ph, v: p.mine });
}

const phaseIndex = (r: number, ph: number) => 2 * r + ph;

/** True if the receiver is in the round and phase of the message, so that delivering it is a step. */
export function enabled(c: VConfig, m: VMsg, crashed = -1): boolean {
  const p = c.p[m.to]!;
  return m.to !== crashed && !p.done && p.r === m.r && p.ph === m.ph;
}

/** Delivers message `id` and returns the new configuration. `horizon` is the last round a process may enter. */
export function deliver(c0: VConfig, id: number, horizon: number): VConfig {
  const c: VConfig = { p: c0.p.map((p) => ({ ...p })), m: c0.m.filter((m) => m.id !== id), nextId: c0.nextId };
  const m = c0.m.find((x) => x.id === id)!;
  const p = c.p[m.to]!;
  if (p.ph === 1) {
    p.mine = p.mine === m.v ? p.mine : null;
    p.ph = 2;
    broadcast(c, m.to);
  } else {
    const props = [p.mine, m.v].filter((v): v is Bit => v !== null);
    if (props.length === 2) {
      // Two proposals in one round are always equal: each needs two matching estimates, and two pairs out of three share one.
      if (p.dec === null) p.dec = props[0]!;
      p.x = props[0]!;
    } else if (props.length === 1) p.x = props[0]!;
    else p.x = coin(p.r);
    if (p.r + 1 > horizon) p.done = true;
    else {
      p.r += 1;
      p.ph = 1;
      p.mine = p.x;
      broadcast(c, m.to);
    }
  }
  // The receiver has left the phase of any other message for it: drop those.
  c.m = c.m.filter((x) => {
    const q = c.p[x.to]!;
    return !q.done && phaseIndex(x.r, x.ph) >= phaseIndex(q.r, q.ph);
  });
  return c;
}

export function decidedMask(c: VConfig): Valence {
  let mask = 0;
  for (const p of c.p) if (p.dec !== null) mask |= 1 << p.dec;
  return mask as Valence;
}

const key = (c: VConfig, crashed: number) =>
  c.p.map((p) => `${p.r}${p.ph}${p.x}${p.mine ?? "n"}${p.dec ?? "n"}${p.done ? 1 : 0}`).join("|") +
  "/" + c.m.map((m) => `${m.from}${m.to}${m.r}${m.ph}${m.v ?? "n"}`).sort().join(",") + "/" + crashed;

/** Valence search with a memo table. Reuse one Explorer across calls to share the work. */
export class Explorer {
  private memo = new Map<string, Valence>();
  /** Rounds that the search looks past the furthest process. */
  constructor(readonly lookahead = 3) {}
  get states() {
    return this.memo.size;
  }
  horizonOf(c: VConfig) {
    return Math.max(...c.p.map((p) => p.r)) + this.lookahead;
  }
  valence(c: VConfig, crashed = -1, horizon = this.horizonOf(c)): Valence {
    const d = decidedMask(c);
    if (d) return d;
    const k = `${horizon}#${key(c, crashed)}`;
    const hit = this.memo.get(k);
    if (hit !== undefined) return hit;
    let mask = 0;
    for (const m of c.m) {
      if (!enabled(c, m, crashed)) continue;
      mask |= this.valence(deliver(c, m.id, horizon), crashed, horizon);
      if (mask === 3) break;
    }
    this.memo.set(k, mask as Valence);
    return mask as Valence;
  }
  /**
   * The adversary of the FLP proof (Lemma 3). Take the oldest message e that can be delivered. Search for a schedule σ
   * without e such that delivering e after σ leaves the configuration bivalent. Returns σ followed by e, or null.
   */
  adversary(c: VConfig, crashed = -1, maxDepth = 8): number[] | null {
    const live = c.m.filter((m) => enabled(c, m, crashed));
    if (!live.length) return null;
    const e = live.reduce((a, b) => (b.id < a.id ? b : a));
    const horizon = this.horizonOf(c);
    let frontier: { c: VConfig; path: number[] }[] = [{ c, path: [] }];
    const seen = new Set<string>();
    for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
      const next: { c: VConfig; path: number[] }[] = [];
      for (const f of frontier) {
        const still = f.c.m.some((m) => m.id === e.id);
        if (!still) {
          // e went stale: its receiver used another message for that phase, so e is delivered and ignored.
          if (this.valence(f.c, crashed) === 3) return f.path;
          continue;
        }
        if (enabled(f.c, e, crashed) && this.valence(deliver(f.c, e.id, horizon), crashed) === 3) return [...f.path, e.id];
        for (const m of f.c.m) {
          if (m.id === e.id || !enabled(f.c, m, crashed)) continue;
          const nc = deliver(f.c, m.id, horizon);
          const k = key(nc, crashed);
          if (seen.has(k) || decidedMask(nc)) continue;
          seen.add(k);
          next.push({ c: nc, path: [...f.path, m.id] });
        }
      }
      frontier = next;
    }
    return null;
  }
}

/** Valence of each of the 8 initial configurations, in the order 000, 001, ..., 111 (process 0 is the left digit). */
export function initialValences(ex = new Explorer()): { inputs: Bit[]; valence: Valence }[] {
  const out: { inputs: Bit[]; valence: Valence }[] = [];
  for (let k = 0; k < 8; k++) {
    const inputs = [(k >> 2) & 1, (k >> 1) & 1, k & 1] as Bit[];
    out.push({ inputs, valence: ex.valence(initial(inputs)) });
  }
  return out;
}

/** Plays the proof's adversary for `steps` deliveries. Returns the run and the rounds it reached with no decision. */
export function adversaryRun(inputs: Bit[], steps: number, ex = new Explorer()) {
  let c = initial(inputs);
  const delivered: VMsg[] = [];
  for (let s = 0; s < steps; ) {
    const path = ex.adversary(c);
    if (!path || !path.length) break;
    for (const id of path) {
      delivered.push(c.m.find((m) => m.id === id)!);
      c = deliver(c, id, ex.horizonOf(c));
      s++;
    }
  }
  return { config: c, delivered, rounds: Math.min(...c.p.map((p) => p.r)), decided: decidedMask(c) };
}

export const valenceName = (v: Valence) => (v === 3 ? "bivalent" : v === 1 ? "0-valent" : v === 2 ? "1-valent" : "stuck");
