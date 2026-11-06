/**
 * Hybrid logical clocks (Kulkarni, Demirbas, Madappa, Avva, Leone: "Logical Physical Clocks", OPODIS 2014).
 * A timestamp is (l, c). l is the largest physical time that the node has heard of; c counts events that share
 * that l. The rules (figure 5 of the paper), with pt the node's physical clock:
 *
 *   send or local:  l' = l;  l = max(l', pt);  c = (l == l') ? c + 1 : 0
 *   receive m:      l' = l;  l = max(l', m.l, pt);
 *                   c = (l == l' == m.l) ? max(c, m.c) + 1 : (l == l') ? c + 1 : (l == m.l) ? m.c + 1 : 0
 *
 * Properties: e → f implies (l, c)(e) < (l, c)(f); l ≥ pt always; l − pt ≤ ε, the largest clock difference between
 * two nodes. The paper packs l into the top 48 bits and c into the low 16 bits of a 64-bit NTP-format timestamp.
 */
import { eventOrder, randomRun, type RandomRunCfg, type Run } from "./events";
import { lamportStamps } from "./lamport";

export interface Hlc { l: number; c: number }
export type HlcRule = "pt" | "msg-l" | "all-equal" | "own-l";

export const hlcLess = (a: Hlc, b: Hlc) => a.l < b.l || (a.l === b.l && a.c < b.c);
export const hlcText = (h: Hlc) => `${h.l},${h.c}`;

/** A send or a local event. Returns the new clock and which case set c. */
export function hlcLocal(h: Hlc, pt: number): { h: Hlc; rule: HlcRule } {
  const l = Math.max(h.l, pt);
  return l === h.l ? { h: { l, c: h.c + 1 }, rule: "own-l" } : { h: { l, c: 0 }, rule: "pt" };
}

/** A receive of a message stamped m. */
export function hlcRecv(h: Hlc, m: Hlc, pt: number): { h: Hlc; rule: HlcRule } {
  const l = Math.max(h.l, m.l, pt);
  if (l === h.l && l === m.l) return { h: { l, c: Math.max(h.c, m.c) + 1 }, rule: "all-equal" };
  if (l === h.l) return { h: { l, c: h.c + 1 }, rule: "own-l" };
  if (l === m.l) return { h: { l, c: m.c + 1 }, rule: "msg-l" };
  return { h: { l, c: 0 }, rule: "pt" };
}

/**
 * The obvious hybrid that the paper rejects: a Lamport clock that never falls behind physical time,
 * l = max(l + 1, m.l + 1, pt), in ms units. Under a high event rate it runs ahead of physical time with no bound.
 */
export const naiveLocal = (l: number, pt: number) => Math.max(l + 1, pt);
export const naiveRecv = (l: number, ml: number, pt: number) => Math.max(l + 1, ml + 1, pt);

/** Packs (l, c) into one 64-bit number as the paper suggests: l in the high 48 bits, c in the low 16 bits. */
export const hlcPack = (h: Hlc): bigint => (BigInt(h.l) << 16n) | BigInt(h.c & 0xffff);
export const hlcUnpack = (x: bigint): Hlc => ({ l: Number(x >> 16n), c: Number(x & 0xffffn) });

export interface HlcStamps {
  hlc: Hlc[];
  rule: HlcRule[];
  lamport: number[];
  naive: number[];
}

/** HLC, Lamport and naive stamps for every event of a run whose events carry pt. */
export function hlcStamps(run: Run): HlcStamps {
  // Start below every reading, so that the first event takes l = pt even when a clock reads below 0.
  const cur: Hlc[] = Array.from({ length: run.n }, () => ({ l: -Infinity, c: 0 }));
  const nv = new Array<number>(run.n).fill(-Infinity);
  const hlc: Hlc[] = run.events.map(() => ({ l: 0, c: 0 }));
  const rule: HlcRule[] = run.events.map(() => "pt");
  const naive = new Array<number>(run.events.length).fill(0);
  for (const id of eventOrder(run)) {
    const e = run.events[id]!;
    const pt = e.pt ?? 0;
    const r = e.kind === "recv" ? hlcRecv(cur[e.proc]!, hlc[run.msgs[e.msg!]!.send]!, pt) : hlcLocal(cur[e.proc]!, pt);
    cur[e.proc] = r.h;
    hlc[id] = r.h;
    rule[id] = r.rule;
    nv[e.proc] = e.kind === "recv" ? naiveRecv(nv[e.proc]!, naive[run.msgs[e.msg!]!.send]!, pt) : naiveLocal(nv[e.proc]!, pt);
    naive[id] = nv[e.proc]!;
  }
  return { hlc, rule, lamport: lamportStamps(run), naive };
}

/** The largest difference between two nodes' clocks at any event time of the run (clocks are linear in time). */
export function maxSkew(run: Run, drift: number[], offset: number[]): number {
  const times = [0, ...run.events.map((e) => e.t)];
  let m = 0;
  for (const t of times) {
    const v = drift.map((d, i) => Math.floor(t * (1 + d) + (offset[i] ?? 0)));
    m = Math.max(m, Math.max(...v) - Math.min(...v));
  }
  return m;
}

export interface HlcRunCfg extends RandomRunCfg { drift: number[]; offset: number[] }

export const HLC_RUN: HlcRunCfg = { n: 3, seed: 4, duration: 300, meanGap: 25, sendProb: 0.6, latency: { min: 3, max: 12 }, drift: [0, 0, 0], offset: [0, 40, -20] };

/** A random run on Net with drifting clocks, with every kind of stamp and the bounds that the paper proves. */
export function hlcRun(cfg: Partial<HlcRunCfg> = {}) {
  const c = { ...HLC_RUN, ...cfg };
  const { run, net } = randomRun(c);
  const s = hlcStamps(run);
  const eps = maxSkew(run, c.drift, c.offset);
  let maxAhead = 0, minAhead = Infinity, maxC = 0, maxNaiveAhead = 0;
  run.events.forEach((e, i) => {
    const a = s.hlc[i]!.l - e.pt!;
    maxAhead = Math.max(maxAhead, a);
    minAhead = Math.min(minAhead, a);
    maxC = Math.max(maxC, s.hlc[i]!.c);
    maxNaiveAhead = Math.max(maxNaiveAhead, s.naive[i]! - e.pt!);
  });
  return { run, net, ...s, eps, maxAhead, minAhead, maxC, maxNaiveAhead };
}

// ---------------------------------------------------------------- uncertainty intervals

export interface UncertainCfg {
  /** Writer's clock − true time, and reader's clock − true time, in ms. */
  writerOffset: number;
  readerOffset: number;
  /** The configured bound on clock offset (CockroachDB: --max-offset, 500ms by default). */
  maxOffset: number;
  /** Real time from the write's commit to the start of the read, in ms. */
  gap: number;
  /** Turn the uncertainty check off, as a plain snapshot read by timestamp would. */
  check: boolean;
}

export const UNCERTAIN_DEFAULT: UncertainCfg = { writerOffset: 120, readerOffset: 0, maxOffset: 250, gap: 50, check: true };

export type UncertainOutcome = "visible" | "restart" | "stale";

/**
 * A write commits at true time 0 with timestamp w = writerOffset (the writer's clock). A read starts `gap` ms later
 * with timestamp r = gap + readerOffset. The value is visible if w ≤ r. If r < w ≤ r + maxOffset, the reader cannot
 * know whether the write came first, so it restarts at a timestamp above w and sees it. If w > r + maxOffset, the
 * reader treats the write as future and misses it. Since the write finished before the read began, that is a stale
 * read. It can happen only when the real clock difference breaks the configured maximum offset.
 */
export function uncertainRead(c: UncertainCfg): { w: number; r: number; outcome: UncertainOutcome; upper: number } {
  const w = c.writerOffset, r = c.gap + c.readerOffset, upper = r + (c.check ? c.maxOffset : 0);
  const outcome: UncertainOutcome = w <= r ? "visible" : w <= upper ? "restart" : "stale";
  return { w, r, outcome, upper };
}
