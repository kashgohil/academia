/**
 * A single-producer single-consumer ring in shared memory, with explicit memory orderings.
 *
 * Memory follows the same view-based model as src/sims/memmodel/cxx.ts. Each location keeps all its writes. Each side has a view:
 * for each location, the oldest write that it may still read. A release store attaches the writer's view to its message.
 * An acquire load of that message joins the view into the reader's view. With relaxed orderings, no view moves, so the
 * consumer can see the new tail and still read the old slot.
 *
 * spscLitmus builds the same program for the memmodel explorer, and the tests check that both agree.
 */
import { explore, type Explored, type Model, type Step } from "../sync/machine";
import { Coherence } from "../../coherence";

export interface SpscOrders { tailStore: "release" | "relaxed"; tailLoad: "acquire" | "relaxed"; headStore: "release" | "relaxed"; headLoad: "acquire" | "relaxed" }
export const CORRECT_ORDERS: SpscOrders = { tailStore: "release", tailLoad: "acquire", headStore: "release", headLoad: "acquire" };
export const RELAXED_ORDERS: SpscOrders = { tailStore: "relaxed", tailLoad: "relaxed", headStore: "relaxed", headLoad: "relaxed" };

export interface SpscSpec { capacity: number; messages: number; orders: SpscOrders }

type View = Record<string, number>;
export interface Msg { v: number; view: View }
export interface SpscSide { pc: number; i: number; view: View; clock: number; /** The value of the index that it read last. */ seen: number }

export interface SpscState {
  slots: Msg[][];
  tail: Msg[];
  head: Msg[];
  p: SpscSide;
  c: SpscSide;
  got: number[];
  /** Consumer clock at its last read of each slot. */
  reads: number[];
  stale: string | null;
  racy: boolean;
  say: string;
}

const join = (a: View, b: View): View => {
  const out = { ...a };
  for (const k in b) if ((out[k] ?? 0) < b[k]!) out[k] = b[k]!;
  return out;
};

export const slotKey = (i: number) => `s${i}`;
export const messageValue = (i: number) => i + 1;

export const PRODUCER_LINES = (o: SpscOrders) => [
  `h = head.load(${o.headLoad});  // full? spin`,
  "slot[t % N] = msg;",
  `tail.store(t + 1, ${o.tailStore});`,
];
export const CONSUMER_LINES = (o: SpscOrders) => [
  `t = tail.load(${o.tailLoad});  // empty? spin`,
  "x = slot[h % N];",
  `head.store(h + 1, ${o.headStore});`,
];

export function spscInitial(spec: SpscSpec): SpscState {
  const side = (): SpscSide => ({ pc: 0, i: 0, view: {}, clock: 0, seen: 0 });
  return {
    slots: Array.from({ length: spec.capacity }, () => [{ v: 0, view: {} }]),
    tail: [{ v: 0, view: {} }],
    head: [{ v: 0, view: {} }],
    p: side(),
    c: side(),
    got: [],
    reads: new Array<number>(spec.capacity).fill(0),
    stale: null,
    racy: false,
    say: "",
  };
}

const cloneS = (s: SpscState): SpscState => ({
  slots: s.slots.map((l) => l.slice()),
  tail: s.tail.slice(),
  head: s.head.slice(),
  p: { ...s.p, view: { ...s.p.view } },
  c: { ...s.c, view: { ...s.c.view } },
  got: s.got.slice(),
  reads: s.reads.slice(),
  stale: s.stale,
  racy: s.racy,
  say: "",
});

export const spscDone = (spec: SpscSpec, s: SpscState) => s.p.i >= spec.messages && s.c.i >= spec.messages;

/** The next steps. A load with several readable values gives one step for each value. Step ids are stable. */
export function spscSteps(spec: SpscSpec, s: SpscState): Step<SpscState>[] {
  const out: Step<SpscState>[] = [];
  const { orders: o, capacity: N, messages: M } = spec;

  // Producer
  if (s.p.i < M) {
    if (s.p.pc === 0) {
      const from = s.p.view.head ?? 0;
      for (let ts = from; ts < s.head.length; ts++) {
        const m = s.head[ts]!;
        const n = cloneS(s);
        n.p.view.head = ts;
        if (o.headLoad === "acquire") n.p.view = join(n.p.view, m.view);
        n.p.seen = m.v;
        const full = s.p.i - m.v >= N;
        if (!full) n.p.pc = 1;
        n.say = full ? `The producer reads head = ${m.v}. The ring is full, so it spins.` : `The producer reads head = ${m.v}. There is room.`;
        out.push({ actor: 0, id: `P${ts}`, text: `read head = ${m.v}${ts < s.head.length - 1 ? " (old)" : ""}`, next: n });
      }
    } else if (s.p.pc === 1) {
      const n = cloneS(s);
      const k = s.p.i % N;
      const key = slotKey(k);
      if ((s.p.view["#c"] ?? 0) < s.reads[k]!) n.racy = true;
      const ts = s.slots[k]!.length;
      n.slots[k] = [...s.slots[k]!, { v: messageValue(s.p.i), view: {} }];
      n.p.view[key] = ts;
      n.p.pc = 2;
      n.say = `The producer stores ${messageValue(s.p.i)} in slot ${k}. The consumer cannot know yet.${n.racy && !s.racy ? " No ordering protects this store from the consumer's read. That is a data race." : ""}`;
      out.push({ actor: 0, id: "P", text: `store ${messageValue(s.p.i)} in slot ${k}`, next: n });
    } else {
      const n = cloneS(s);
      const ts = s.tail.length;
      n.p.view.tail = ts;
      const view: View = o.tailStore === "release" ? { ...n.p.view } : { tail: ts };
      n.tail = [...s.tail, { v: s.p.i + 1, view }];
      n.p.pc = 0;
      n.p.i++;
      n.say = `The producer publishes tail = ${s.p.i + 1}${o.tailStore === "release" ? ". The release carries its view of the slot" : ". With relaxed, the tail carries no view"}.`;
      out.push({ actor: 0, id: "P", text: `publish tail = ${s.p.i + 1}`, next: n });
    }
  }

  // Consumer
  if (s.c.i < M) {
    if (s.c.pc === 0) {
      const from = s.c.view.tail ?? 0;
      for (let ts = from; ts < s.tail.length; ts++) {
        const m = s.tail[ts]!;
        const n = cloneS(s);
        n.c.view.tail = ts;
        if (o.tailLoad === "acquire") n.c.view = join(n.c.view, m.view);
        n.c.seen = m.v;
        const empty = m.v <= s.c.i;
        if (!empty) n.c.pc = 1;
        n.say = empty ? `The consumer reads tail = ${m.v}. The ring is empty, so it spins.` : `The consumer reads tail = ${m.v}. A message is ready${o.tailLoad === "acquire" && o.tailStore === "release" ? ", and the acquire moves its view of the slot forward" : ""}.`;
        out.push({ actor: 1, id: `C${ts}`, text: `read tail = ${m.v}${ts < s.tail.length - 1 ? " (old)" : ""}`, next: n });
      }
    } else if (s.c.pc === 1) {
      const k = s.c.i % N;
      const key = slotKey(k);
      const list = s.slots[k]!;
      const from = s.c.view[key] ?? 0;
      for (let ts = from; ts < list.length; ts++) {
        const m = list[ts]!;
        const n = cloneS(s);
        n.c.view[key] = ts;
        n.c.clock++;
        n.c.view["#c"] = n.c.clock;
        n.reads[k] = n.c.clock;
        if (list.length - 1 > from) n.racy = true;
        n.got.push(m.v);
        n.c.pc = 2;
        const want = messageValue(s.c.i);
        if (m.v !== want && !n.stale) n.stale = `The consumer read ${m.v} from slot ${k}, but message ${s.c.i + 1} is ${want}. The tail said that the message was ready. The slot was stale.`;
        n.say = m.v === want ? `The consumer reads ${m.v} from slot ${k}. That is the right message.` : `The consumer reads ${m.v} from slot ${k}. It wanted ${want}.`;
        out.push({ actor: 1, id: `C${ts}`, text: `read slot ${k} = ${m.v}${ts < list.length - 1 ? " (old)" : ""}`, next: n });
      }
    } else {
      const n = cloneS(s);
      const ts = s.head.length;
      n.c.view.head = ts;
      const view: View = o.headStore === "release" ? { ...n.c.view } : { head: ts };
      n.head = [...s.head, { v: s.c.i + 1, view }];
      n.c.pc = 0;
      n.c.i++;
      n.say = `The consumer publishes head = ${s.c.i + 1}. The slot can now be used again.`;
      out.push({ actor: 1, id: "C", text: `publish head = ${s.c.i + 1}`, next: n });
    }
  }
  return out;
}

const viewKey = (v: View) => Object.keys(v).sort().map((k) => `${k}:${v[k]}`).join(",");
const msgsKey = (l: Msg[]) => l.map((m) => `${m.v}{${viewKey(m.view)}}`).join("|");
const sideKey = (x: SpscSide) => `${x.pc}/${x.i}/${viewKey(x.view)}/${x.clock}`;

/** `stopAtStale` makes a stale read a safety violation, and the explorer reports the shortest schedule. */
export function spscModel(spec: SpscSpec, opts: { stopAtStale?: boolean } = {}): Model<SpscState> {
  return {
    init: spscInitial(spec),
    key: (s) => [s.slots.map(msgsKey).join(";"), msgsKey(s.tail), msgsKey(s.head), sideKey(s.p), sideKey(s.c), s.got.join(","), s.reads.join(","), +s.racy].join("#"),
    steps: (s) => spscSteps(spec, s),
    done: (s) => spscDone(spec, s),
    check: (s) => (opts.stopAtStale ? s.stale : null),
    outcome: (s) => `${s.got.join(",")}${s.racy ? " racy" : ""}`,
  };
}

export const exploreSpsc = (spec: SpscSpec, stopAtStale = true): Explored => explore(spscModel(spec, { stopAtStale }));

/** The same ring as a litmus test for src/sims/memmodel. Consumer registers are r0, r1, ... */
export function spscLitmus(spec: SpscSpec): string {
  const { capacity: N, messages: M, orders: o } = spec;
  const t0: string[] = [];
  const t1: string[] = [];
  for (let i = 0; i < M; i++) {
    if (i >= N) t0.push(`head.await(${i - N + 1}, ${o.headLoad})`);
    t0.push(`s${i % N} = ${messageValue(i)}`);
    t0.push(`tail.store(${i + 1}, ${o.tailStore})`);
    t1.push(`tail.await(${i + 1}, ${o.tailLoad})`);
    t1.push(`r${i} = s${i % N}`);
    if (i + 1 <= M - N) t1.push(`head.store(${i + 1}, ${o.headStore})`);
  }
  return `T0:\n  ${t0.join("\n  ")}\nT1:\n  ${t1.join("\n  ")}\n`;
}

// ---------------------------------------------------------------- cache lines of the ring indices

export interface LineTraffic { messages: number; transfers: number; perMessage: number; indexReads: number; indexReadsPerMessage: number }

/**
 * Runs the memory accesses of a ring through the MESI simulator, with both sides running at once. The steps of the two
 * sides alternate, and the consumer stays `backlog` messages behind. With cached copies, a side reads the other side's
 * index only when its copy says full or empty.
 */
export function spscLineTraffic(opts: { padded: boolean; cached: boolean; backlog?: number; messages?: number; capacity?: number }): LineTraffic {
  const N = opts.capacity ?? 64;
  const backlog = opts.backlog ?? 8;
  const messages = opts.messages ?? 2000;
  const HEAD = 0;
  const TAIL = opts.padded ? 1 : 0;
  const slotLine = (i: number) => 2 + (i % N);
  const c = new Coherence(2, N + 4, "MESI");
  const cached = opts.cached;
  let tail = 0, head = 0, cachedHead = 0, cachedTail = 0, indexReads = 0;
  // The producer gets a head start, so that the ring holds `backlog` messages.
  for (; tail < backlog; tail++) { c.write(0, slotLine(tail), tail); c.write(0, TAIL, tail + 1); }
  const start = { ...c.c };
  for (let m = 0; m < messages; m++) {
    if (!cached || tail - cachedHead >= N) { c.read(0, HEAD); cachedHead = head; indexReads++; }
    if (!cached || head >= cachedTail) { c.read(1, TAIL); cachedTail = tail; indexReads++; }
    c.write(0, slotLine(tail), tail);
    c.read(1, slotLine(head));
    tail++;
    c.write(0, TAIL, tail);
    head++;
    c.write(1, HEAD, head);
  }
  const transfers = c.c.c2c + c.c.invalidations - start.c2c - start.invalidations;
  return { messages, transfers, perMessage: transfers / messages, indexReads, indexReadsPerMessage: indexReads / messages };
}
