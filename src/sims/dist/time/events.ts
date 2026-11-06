/**
 * A run of a message-passing system as a list of events: local events, sends and receives on n processes.
 * Logical clocks (Lamport, vector, HLC) are functions of a run. Happens-before is computed here directly from the
 * graph of the run (program order plus send → receive), with no clock at all, so that tests can check each clock
 * against it.
 *
 * Two ways to get a run:
 * - the builder (emptyRun, addLocal, addSend, deliver) for a run that a learner makes by hand, one event at a time;
 * - randomRun, which runs processes on the shared Net with random timers, latencies and clocks.
 */
import { Net } from "../net";

export type EventKind = "local" | "send" | "recv";

export interface Ev {
  /** Index in Run.events. */
  id: number;
  proc: number;
  kind: EventKind;
  /** Real time (Net time in ms) or, for a hand-built run, the order of creation. */
  t: number;
  /** For a send or a receive: the message id. */
  msg?: number;
  /** The physical clock that the process read at this event (ms, rounded down). Only randomRun sets it. */
  pt?: number;
}

export interface RunMsg {
  id: number;
  from: number;
  to: number;
  /** The id of the send event. */
  send: number;
  /** The id of the receive event; undefined while the message is in flight. */
  recv?: number;
}

export interface Run {
  n: number;
  events: Ev[];
  msgs: RunMsg[];
}

export const emptyRun = (n: number): Run => ({ n, events: [], msgs: [] });

const push = (run: Run, e: Omit<Ev, "id" | "t">): Run => {
  const ev: Ev = { ...e, id: run.events.length, t: run.events.length };
  return { ...run, events: [...run.events, ev] };
};

/** A local event on process p. */
export const addLocal = (run: Run, p: number): Run => push(run, { proc: p, kind: "local" });

/** A send event on `from`. The message stays in flight until `deliver`. */
export function addSend(run: Run, from: number, to: number): Run {
  const id = run.msgs.length;
  const r = push(run, { proc: from, kind: "send", msg: id });
  return { ...r, msgs: [...r.msgs, { id, from, to, send: r.events.length - 1 }] };
}

/** The receive event of message `msgId` on its destination. */
export function deliver(run: Run, msgId: number): Run {
  const m = run.msgs[msgId];
  if (!m || m.recv !== undefined) return run;
  const r = push(run, { proc: m.to, kind: "recv", msg: msgId });
  return { ...r, msgs: r.msgs.map((x) => (x.id === msgId ? { ...x, recv: r.events.length - 1 } : x)) };
}

/** Builds a run from a short script: "L0" local on P1, "S0>2" send P1 to P3, "D3" deliver message 3. */
export function scriptRun(n: number, script: string[]): Run {
  let r = emptyRun(n);
  for (const s of script) {
    if (s[0] === "L") r = addLocal(r, Number(s.slice(1)));
    else if (s[0] === "S") { const [a, b] = s.slice(1).split(">"); r = addSend(r, Number(a), Number(b)); }
    else if (s[0] === "D") r = deliver(r, Number(s.slice(1)));
  }
  return r;
}

/** The preset run of the lessons: P3 does three local events while P1 talks to P2. Events j (C = 3) and h (C = 4) are concurrent. */
export const LESSON_RUN = ["L0", "S0>1", "L2", "L2", "L2", "L1", "D0", "S1>2", "D1", "L0"];

/** Messages that are sent and not yet delivered. */
export const inFlight = (run: Run) => run.msgs.filter((m) => m.recv === undefined);

/** Event ids in the order in which a clock must process them: by time, then by id. */
export const eventOrder = (run: Run) => [...run.events].sort((a, b) => a.t - b.t || a.id - b.id).map((e) => e.id);

/** The previous event on the same process, for each event (or -1). */
export function prevOnProc(run: Run): number[] {
  const last = new Array<number>(run.n).fill(-1);
  const prev = new Array<number>(run.events.length).fill(-1);
  for (const id of eventOrder(run)) {
    const e = run.events[id]!;
    prev[id] = last[e.proc]!;
    last[e.proc] = id;
  }
  return prev;
}

/**
 * Happens-before (Lamport 1978) as a closure over the graph of the run: a → b if a comes before b on one process,
 * or a is the send of a message whose receive is b, or by transitivity. hb[b] is the set of every a with a → b.
 */
export function happensBefore(run: Run): Set<number>[] {
  const prev = prevOnProc(run);
  const hb: Set<number>[] = run.events.map(() => new Set<number>());
  for (const id of eventOrder(run)) {
    const e = run.events[id]!;
    const into = hb[id]!;
    const p = prev[id]!;
    if (p >= 0) { into.add(p); for (const x of hb[p]!) into.add(x); }
    if (e.kind === "recv") {
      const s = run.msgs[e.msg!]!.send;
      into.add(s);
      for (const x of hb[s]!) into.add(x);
    }
  }
  return hb;
}

export type Relation = "before" | "after" | "same" | "concurrent";

/** How a relates to b: a → b ("before"), b → a ("after"), or neither ("concurrent"). */
export function relation(hb: Set<number>[], a: number, b: number): Relation {
  if (a === b) return "same";
  if (hb[b]!.has(a)) return "before";
  if (hb[a]!.has(b)) return "after";
  return "concurrent";
}

/** Short names for events: a, b, c, …, z, a2, b2, … */
export const evName = (id: number) => String.fromCharCode(97 + (id % 26)) + (id >= 26 ? String(1 + Math.floor(id / 26)) : "");

export interface RandomRunCfg {
  n: number;
  seed: number;
  /** Simulated time in ms. */
  duration: number;
  /** Mean ms between two spontaneous events on one process. */
  meanGap: number;
  /** Probability that a spontaneous event sends a message (else it is a local event). */
  sendProb: number;
  latency: { min: number; max: number };
  /** Clock rate error per process (50e-6 = 50 ppm fast) and offset in ms. */
  drift?: number[];
  offset?: number[];
}

export const RANDOM_RUN: RandomRunCfg = { n: 3, seed: 1, duration: 200, meanGap: 20, sendProb: 0.5, latency: { min: 5, max: 30 } };

/**
 * A run of n processes on the shared Net. Each process wakes at random (exponential gaps), and then does a local
 * event or sends to a random other process. Every delivery is a receive event. Each event records the physical
 * clock pt that its process read, from Net's drift and offset.
 */
export function randomRun(cfg: Partial<RandomRunCfg> = {}): { run: Run; net: Net<{ m: number }> } {
  const c = { ...RANDOM_RUN, ...cfg };
  const events: Ev[] = [];
  const msgs: RunMsg[] = [];
  const add = (net: Net<{ m: number }>, e: Omit<Ev, "id" | "t" | "pt">) => {
    const ev: Ev = { ...e, id: events.length, t: net.now, pt: Math.floor(net.clock(e.proc)) };
    events.push(ev);
    return ev.id;
  };
  const gap = (net: Net<{ m: number }>) => Math.max(0.5, -Math.log(1 - net.random()) * c.meanGap);
  const net: Net<{ m: number }> = new Net<{ m: number }>(c.n, { seed: c.seed, latency: c.latency }, {
    onTimer(p, _tag, x) {
      if (x.now > c.duration) return;
      if (c.n > 1 && x.random() < c.sendProb) {
        let to = Math.floor(x.random() * (c.n - 1));
        if (to >= p) to++;
        const id = msgs.length;
        const send = add(x, { proc: p, kind: "send", msg: id });
        msgs.push({ id, from: p, to, send });
        x.send(p, to, { m: id });
      } else add(x, { proc: p, kind: "local" });
      x.setTimer(p, gap(x), "tick");
    },
    onMessage(p, m, x) {
      const r = add(x, { proc: p, kind: "recv", msg: m.payload.m });
      msgs[m.payload.m]!.recv = r;
    },
  });
  for (let i = 0; i < c.n; i++) {
    net.drift[i] = c.drift?.[i] ?? 0;
    net.offset[i] = c.offset?.[i] ?? 0;
    net.setTimer(i, gap(net), "tick");
  }
  net.runAll();
  return { run: { n: c.n, events, msgs }, net };
}
