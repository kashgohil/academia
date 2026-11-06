/**
 * Session guarantees (Terry et al., PDIS 1994) for a mobile client and weakly consistent servers, on the shared Net.
 *
 * Each server keeps an ordered log of writes. A write gets an id (origin server, sequence number). Anti-entropy sends
 * a whole log to a random peer every `interval` ms, and the peer appends the writes it lacks in the same order. So a
 * server that has a write also has every write that its origin had before it (the prefix property). Then a version
 * vector, the highest sequence number per origin, describes a log exactly.
 *
 * The client keeps two vectors: the write-set (its own writes) and the read-set (what its reads saw). A guarantee is
 * a check that a server makes before it serves a request:
 *   read your writes      read:  server vector ≥ write-set
 *   monotonic reads       read:  server vector ≥ read-set
 *   writes follow reads   write: server vector ≥ read-set
 *   monotonic writes      write: server vector ≥ write-set
 * If the check fails, the server waits until anti-entropy brings the missing writes.
 */
import { Net } from "../net";

export type Guarantee = "ryw" | "mr" | "wfr" | "mw";
export const GUARANTEES: Guarantee[] = ["ryw", "mr", "wfr", "mw"];
export const GUARANTEE_NAMES: Record<Guarantee, string> = { ryw: "Read your writes", mr: "Monotonic reads", wfr: "Writes follow reads", mw: "Monotonic writes" };

export interface WriteRec { label: string; origin: number; seq: number }
export interface SessionStep { f: "r" | "w"; server: number }

export interface SessionConfig {
  seed: number;
  servers: number;
  /** Anti-entropy period (ms). */
  interval: number;
  /** The client's steps; one starts `gap` ms after the previous one ends. */
  steps: SessionStep[];
  gap: number;
  /** Writes by another user (Bob): [server, time]. */
  others: [number, number][];
  on: Record<Guarantee, boolean>;
  tEnd: number;
}

export const DEFAULT_SESSION: SessionConfig = {
  seed: 7, servers: 3, interval: 80, gap: 12, tEnd: 600,
  others: [[2, 0]],
  steps: [{ f: "r", server: 2 }, { f: "w", server: 0 }, { f: "r", server: 1 }, { f: "w", server: 1 }, { f: "r", server: 2 }],
  on: { ryw: false, mr: false, wfr: false, mw: false },
};

type Vec = number[];
const dominates = (a: Vec, b: Vec) => b.every((x, i) => (a[i] ?? 0) >= x);
const maxv = (a: Vec, b: Vec) => a.map((x, i) => Math.max(x, b[i] ?? 0));

type SMsg =
  | { k: "req"; step: number; f: "r" | "w"; need: Vec; label?: string }
  | { k: "resp"; step: number; log: string[]; vec: Vec; wrote?: WriteRec }
  | { k: "ae"; log: WriteRec[] };

export interface StepResult {
  step: number;
  f: "r" | "w";
  server: number;
  label?: string;
  start: number;
  /** When the request reached the server. */
  arrived: number;
  /** When the server served it, and when the client got the answer. */
  served: number;
  end: number;
  /** For a read: the labels it saw. */
  saw?: string[];
  /** Labels of writes that a guarantee said this read must see, but it did not. */
  missingOwn?: string[];
  missingSeen?: string[];
}

export interface Anomaly { kind: Guarantee; t: number; server: number; text: string }

export interface SessionRun {
  cfg: SessionConfig;
  net: Net<SMsg>;
  steps: StepResult[];
  anomalies: Anomaly[];
  /** Each server's log over time: [time, labels]. */
  logs: [number, string[]][][];
  /** Total time that requests waited at servers for a guarantee. */
  waited: number;
}

export function runSession(partial: Partial<SessionConfig> = {}): SessionRun {
  const cfg: SessionConfig = { ...DEFAULT_SESSION, ...partial, on: { ...DEFAULT_SESSION.on, ...partial.on } };
  const S = cfg.servers, CLIENT = S;
  const zero = () => new Array<number>(S).fill(0);
  const logs: WriteRec[][] = Array.from({ length: S }, () => []);
  const vec: Vec[] = Array.from({ length: S }, zero);
  const seq = new Array<number>(S).fill(0);
  const queue: { from: number; m: Extract<SMsg, { k: "req" }> }[][] = Array.from({ length: S }, () => []);
  const logHist: [number, string[]][][] = Array.from({ length: S }, () => [[0, []]]);
  const anomalies: Anomaly[] = [];
  const results: StepResult[] = [];

  // Client session state.
  let writeSet = zero(), readSet = zero();
  const ownWrites: string[] = [];
  const seenByReads = new Set<string>();
  /** For each client write: the writes that must come before it (by MW and by WFR). */
  const mustPrecede = new Map<string, { mw: string[]; wfr: string[] }>();
  let nextLabel = 1;

  const record = (s: number, now: number) => logHist[s]!.push([now, logs[s]!.map((w) => w.label)]);
  const checkOrder = (s: number, w: WriteRec, now: number) => {
    const pre = mustPrecede.get(w.label);
    if (!pre) return;
    const have = new Set(logs[s]!.map((x) => x.label));
    const mw = pre.mw.filter((l) => !have.has(l));
    const wfr = pre.wfr.filter((l) => !have.has(l));
    if (mw.length) anomalies.push({ kind: "mw", t: now, server: s, text: `S${s + 1} has ${w.label} but not ${mw.join(", ")}` });
    if (wfr.length) anomalies.push({ kind: "wfr", t: now, server: s, text: `S${s + 1} has ${w.label} but not ${wfr.join(", ")}` });
  };
  const append = (s: number, w: WriteRec, now: number) => {
    logs[s]!.push(w);
    vec[s]![w.origin] = Math.max(vec[s]![w.origin]!, w.seq);
    checkOrder(s, w, now);
    record(s, now);
  };
  const serve = (net: Net<SMsg>, s: number, from: number, m: Extract<SMsg, { k: "req" }>) => {
    const r = results[m.step]!;
    r.served = net.now;
    if (m.f === "w") {
      const w: WriteRec = { label: m.label!, origin: s, seq: ++seq[s]! };
      append(s, w, net.now);
      net.send(s, from, { k: "resp", step: m.step, log: [], vec: [...vec[s]!], wrote: w });
    } else net.send(s, from, { k: "resp", step: m.step, log: logs[s]!.map((w) => w.label), vec: [...vec[s]!] });
  };
  const drain = (net: Net<SMsg>, s: number) => {
    const q = queue[s]!;
    for (let i = 0; i < q.length; ) {
      if (dominates(vec[s]!, q[i]!.m.need)) { const { from, m } = q.splice(i, 1)[0]!; serve(net, s, from, m); }
      else i++;
    }
  };
  const startStep = (net: Net<SMsg>, i: number) => {
    const st = cfg.steps[i];
    if (!st) return;
    let need = zero();
    if (st.f === "r") {
      if (cfg.on.ryw) need = maxv(need, writeSet);
      if (cfg.on.mr) need = maxv(need, readSet);
    } else {
      if (cfg.on.wfr) need = maxv(need, readSet);
      if (cfg.on.mw) need = maxv(need, writeSet);
    }
    const label = st.f === "w" ? `A${nextLabel++}` : undefined;
    if (label) mustPrecede.set(label, { mw: [...ownWrites], wfr: [...seenByReads].filter((l) => !ownWrites.includes(l)) });
    results[i] = { step: i, f: st.f, server: st.server, label, start: net.now, arrived: NaN, served: NaN, end: NaN };
    net.send(CLIENT, st.server, { k: "req", step: i, f: st.f, need, label });
  };

  const net = new Net<SMsg>(S + 1, { seed: cfg.seed, latency: { min: 2, max: 6 } }, {
    onMessage(node, msg, net) {
      const p = msg.payload;
      if (node === CLIENT && p.k === "resp") {
        const r = results[p.step]!;
        r.end = net.now;
        if (p.wrote) {
          writeSet = maxv(writeSet, p.vec.map((_, i) => (i === p.wrote!.origin ? p.wrote!.seq : 0)));
          ownWrites.push(p.wrote.label);
        } else {
          r.saw = p.log;
          r.missingOwn = ownWrites.filter((l) => !p.log.includes(l));
          r.missingSeen = [...seenByReads].filter((l) => !p.log.includes(l));
          if (r.missingOwn.length) anomalies.push({ kind: "ryw", t: net.now, server: r.server, text: `read at S${r.server + 1} misses own ${r.missingOwn.join(", ")}` });
          if (r.missingSeen.length) anomalies.push({ kind: "mr", t: net.now, server: r.server, text: `read at S${r.server + 1} misses ${r.missingSeen.join(", ")}, seen before` });
          p.log.forEach((l) => seenByReads.add(l));
          readSet = maxv(readSet, p.vec);
        }
        net.setTimer(CLIENT, cfg.gap, `step${p.step + 1}`);
        return;
      }
      if (p.k === "req") {
        results[p.step]!.arrived = net.now;
        if (dominates(vec[node]!, p.need)) serve(net, node, msg.from, p);
        else queue[node]!.push({ from: msg.from, m: p });
      } else if (p.k === "ae") {
        const have = new Set(logs[node]!.map((w) => w.label));
        let grew = false;
        for (const w of p.log) if (!have.has(w.label)) { append(node, w, net.now); grew = true; }
        if (grew) drain(net, node);
      }
    },
    onTimer(node, tag, net) {
      if (node === CLIENT && tag.startsWith("step")) return startStep(net, Number(tag.slice(4)));
      if (tag.startsWith("bob")) {
        append(node, { label: `B${tag.slice(3)}`, origin: node, seq: ++seq[node]! }, net.now);
        return drain(net, node);
      }
      if (tag === "ae" && net.now < cfg.tEnd) {
        const j = (node + 1 + Math.floor(net.random() * (S - 1))) % S;
        net.send(node, j, { k: "ae", log: [...logs[node]!] });
        net.setTimer(node, cfg.interval, "ae");
      }
    },
  });

  cfg.others.forEach(([s, t], i) => net.setTimer(s, t, `bob${i + 1}`));
  for (let s = 0; s < S; s++) net.setTimer(s, net.random() * cfg.interval, "ae");
  net.setTimer(CLIENT, 5, "step0");
  net.runUntil(cfg.tEnd + 50);
  const waited = results.reduce((a, r) => a + (Number.isFinite(r.served) ? r.served - r.arrived : 0), 0);
  return { cfg, net, steps: results, anomalies, logs: logHist, waited };
}
