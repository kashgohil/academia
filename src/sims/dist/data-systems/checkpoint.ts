/**
 * Checkpoints with barriers (Chandy-Lamport, in the form Flink uses: Carbone et al., 2015), on the shared Net.
 *
 * Graph: source A (node 0) and source B (node 1) read their input logs and send records to a counting operator C
 * (node 2), which forwards each record to a sink K (node 3). Node 4 is the coordinator (Flink's JobManager).
 * Channels are FIFO, as the algorithm needs.
 *
 * - Every `interval` ms the coordinator asks both sources for checkpoint n. A source records its read offset and
 *   sends barrier n downstream, in line with its records.
 * - aligned: when C gets barrier n on one input, it stops reading that input (it buffers what comes after it)
 *   until barrier n has come on every input. Then it records its state, forwards the barrier and reads on.
 * - not aligned (Flink's at-least-once mode): C does not block. It records its state when the last barrier comes,
 *   so the state may include records that came after the first barrier.
 * - Each task acknowledges with its state; checkpoint n is complete when all four have.
 * - A crash of C: after `detect` ms the coordinator restarts every task from the last complete checkpoint. Sources
 *   rewind to their recorded offsets, C gets its recorded counts, and messages in flight are discarded (each message
 *   carries the run generation). The sink is an outside system: what it received stays.
 * All timings are MODEL INPUTS.
 */
import { Net } from "../net";

export const CK = { A: 0, B: 1, C: 2, K: 3, JM: 4 } as const;
export const CK_NAMES = ["A", "B", "C", "sink", "coord"];

export interface CkConfig {
  seed: number;
  aligned: boolean;
  /** Input sizes and the time between records of each source. */
  nA: number;
  nB: number;
  aEvery: number;
  bEvery: number;
  interval: number;
  firstCheckpoint: number;
  /** Crash C at this time; null: no crash. */
  crashAt: number | null;
  detect: number;
  latency: { min: number; max: number };
}

export const CK_DEFAULTS: CkConfig = {
  seed: 2, aligned: true, nA: 16, nB: 6, aEvery: 10, bEvery: 28, interval: 70, firstCheckpoint: 45,
  crashAt: 100, detect: 15, latency: { min: 6, max: 12 },
};

export type CkMsg =
  | { k: "rec"; src: "a" | "b"; seq: number; gen: number }
  | { k: "barrier"; id: number; gen: number }
  | { k: "trigger"; id: number; gen: number }
  | { k: "ack"; id: number; gen: number; state: Record<string, number> };

export interface CkSnapshot { id: number; offA: number; offB: number; cA: number; cB: number }

export interface CkFrame {
  t: number;
  caption: string;
  offA: number;
  offB: number;
  cA: number;
  cB: number;
  /** Inputs of C that are blocked (aligned mode), and how many records wait in its buffer. */
  blocked: ("a" | "b")[];
  buffered: number;
  sinkGot: number;
  sinkDup: number;
  completed: CkSnapshot[];
  up: boolean;
  /** Messages in flight on each edge, oldest first: a7 is record 7 of A, |2 is barrier 2. */
  edges: { AC: string[]; BC: string[]; CK: string[] };
  gen: number;
}

export interface CkRun {
  cfg: CkConfig;
  net: Net<CkMsg>;
  frames: CkFrame[];
  final: { cA: number; cB: number; sinkGot: number; sinkDup: number };
  completed: CkSnapshot[];
  restoredFrom: CkSnapshot | null;
}

export function runCheckpoint(partial: Partial<CkConfig> = {}): CkRun {
  const cfg: CkConfig = { ...CK_DEFAULTS, ...partial, latency: { ...CK_DEFAULTS.latency, ...partial.latency } };
  let gen = 0;
  const src = { a: 0, b: 0 }; // next offset to read
  const op = { cA: 0, cB: 0 };
  let aligning: number | null = null;
  const seen = new Set<"a" | "b">();
  const blocked = new Set<"a" | "b">();
  let buffer: CkMsg[] = [];
  const sink = new Map<string, number>();
  let sinkGot = 0;
  const acks = new Map<number, Map<number, Record<string, number>>>();
  const completed: CkSnapshot[] = [];
  let nextCk = 1;
  let restoredFrom: CkSnapshot | null = null;
  const frames: CkFrame[] = [];
  let caption = "Start. Sources read their logs; C counts the records from each.";

  const process = (m: CkMsg, net: Net<CkMsg>) => {
    if (m.k !== "rec") return;
    if (m.src === "a") op.cA++;
    else op.cB++;
    net.send(CK.C, CK.K, m);
  };

  const snapshotC = (id: number, net: Net<CkMsg>) => {
    net.send(CK.C, CK.JM, { k: "ack", id, gen, state: { cA: op.cA, cB: op.cB } });
    net.send(CK.C, CK.K, { k: "barrier", id, gen });
  };

  const net = new Net<CkMsg>(5, { seed: cfg.seed, latency: cfg.latency, fifo: true }, {
    onMessage(node, msg, nt) {
      const m = msg.payload;
      if (m.gen !== gen) return; // from before a restart
      if (node === CK.A || node === CK.B) {
        if (m.k !== "trigger") return;
        const off = node === CK.A ? src.a : src.b;
        nt.send(node, CK.C, { k: "barrier", id: m.id, gen });
        nt.send(node, CK.JM, { k: "ack", id: m.id, gen, state: { off } });
        caption = `Source ${node === CK.A ? "A" : "B"} records offset ${off} and sends barrier ${m.id} after its records.`;
      } else if (node === CK.C) {
        const input: "a" | "b" = msg.from === CK.A ? "a" : "b";
        if (m.k === "rec") {
          if (blocked.has(input)) { buffer.push(m); caption = `C buffers ${input}${m.seq}: input ${input.toUpperCase()} is blocked until the other barrier comes.`; return; }
          process(m, nt);
          caption = `C counts ${input}${m.seq}${aligning !== null && !cfg.aligned && seen.has(input) ? ", after this input's barrier: it will be in the snapshot" : ""}.`;
        } else if (m.k === "barrier") {
          aligning = m.id;
          seen.add(input);
          if (seen.size < 2) {
            if (cfg.aligned) blocked.add(input);
            caption = cfg.aligned
              ? `Barrier ${m.id} from ${input.toUpperCase()}. C blocks input ${input.toUpperCase()} and waits for the barrier from the other input.`
              : `Barrier ${m.id} from ${input.toUpperCase()}. Without alignment, C keeps counting records from ${input.toUpperCase()}.`;
            return;
          }
          snapshotC(m.id, nt);
          caption = `Barrier ${m.id} on both inputs. C records its counts (A ${op.cA}, B ${op.cB}) and forwards the barrier.`;
          seen.clear();
          blocked.clear();
          aligning = null;
          const waiting = buffer;
          buffer = [];
          for (const w of waiting) process(w, nt);
        }
      } else if (node === CK.K) {
        if (m.k === "rec") {
          const key = `${m.src}${m.seq}`;
          sink.set(key, (sink.get(key) ?? 0) + 1);
          sinkGot++;
          caption = sink.get(key)! > 1 ? `The sink gets ${key} again: a duplicate output.` : `The sink gets ${key}.`;
        } else if (m.k === "barrier") {
          nt.send(CK.K, CK.JM, { k: "ack", id: m.id, gen, state: {} });
          caption = `The sink gets barrier ${m.id} and acknowledges it.`;
        }
      } else if (node === CK.JM && m.k === "ack") {
        const a = acks.get(m.id) ?? new Map();
        a.set(msg.from, m.state);
        acks.set(m.id, a);
        if (a.size === 4) {
          const s: CkSnapshot = { id: m.id, offA: a.get(CK.A)!.off!, offB: a.get(CK.B)!.off!, cA: a.get(CK.C)!.cA!, cB: a.get(CK.C)!.cB! };
          completed.push(s);
          caption = `Checkpoint ${m.id} is complete: A at ${s.offA}, B at ${s.offB}, C counted ${s.cA} and ${s.cB}.`;
        }
      }
    },
    onTimer(node, tag, nt) {
      const [kind, g] = tag.split(":");
      if (kind === "crash") {
        nt.crash(CK.C);
        caption = `C crashes. Its counts (A ${op.cA}, B ${op.cB}) are lost, and so are the records sent to it.`;
        nt.setTimer(CK.JM, cfg.detect, "detect");
        return;
      }
      if (Number(g) !== gen && kind !== "detect") return;
      if (kind === "emit") {
        const s = node === CK.A ? "a" : "b";
        const n = s === "a" ? cfg.nA : cfg.nB;
        if (src[s] >= n) return;
        src[s]++;
        nt.send(node, CK.C, { k: "rec", src: s, seq: src[s], gen });
        nt.setTimer(node, s === "a" ? cfg.aEvery : cfg.bEvery, `emit:${gen}`);
        caption = `Source ${s.toUpperCase()} reads record ${s}${src[s]} and sends it.`;
      } else if (kind === "trigger") {
        const id = nextCk++;
        if (src.a < cfg.nA || src.b < cfg.nB) nt.setTimer(CK.JM, cfg.interval, `trigger:${gen}`);
        nt.send(CK.JM, CK.A, { k: "trigger", id, gen });
        nt.send(CK.JM, CK.B, { k: "trigger", id, gen });
        caption = `The coordinator starts checkpoint ${id}.`;
      } else if (kind === "detect") {
        // Restart everything from the last complete checkpoint.
        gen++;
        const last = completed[completed.length - 1] ?? null;
        restoredFrom = last;
        src.a = last?.offA ?? 0;
        src.b = last?.offB ?? 0;
        op.cA = last?.cA ?? 0;
        op.cB = last?.cB ?? 0;
        seen.clear();
        blocked.clear();
        buffer = [];
        aligning = null;
        acks.clear();
        nt.recover(CK.C);
        nt.setTimer(CK.A, 1, `emit:${gen}`);
        nt.setTimer(CK.B, 1, `emit:${gen}`);
        nt.setTimer(CK.JM, cfg.interval, `trigger:${gen}`);
        caption = last
          ? `Restart from checkpoint ${last.id}: A rewinds to ${last.offA}, B to ${last.offB}, C restores ${last.cA} and ${last.cB}. In-flight messages are dropped.`
          : "Restart from the beginning: no checkpoint was complete.";
      }
    },
  });

  const inflight = (from: number, to: number) =>
    net.messages.filter((m) => m.from === from && m.to === to && m.deliveredAt === undefined && !m.lost && m.payload.gen === gen && net.isUp(to))
      .map((m) => (m.payload.k === "rec" ? `${m.payload.src}${m.payload.seq}` : m.payload.k === "barrier" ? `|${m.payload.id}` : ""));
  const frame = () => {
    let dup = 0;
    for (const v of sink.values()) if (v > 1) dup += v - 1;
    frames.push({
      t: net.now, caption, offA: src.a, offB: src.b, cA: op.cA, cB: op.cB, blocked: [...blocked], buffered: buffer.length,
      sinkGot, sinkDup: dup, completed: completed.slice(), up: net.isUp(CK.C), gen,
      edges: { AC: inflight(CK.A, CK.C), BC: inflight(CK.B, CK.C), CK: inflight(CK.C, CK.K) },
    });
  };

  net.setTimer(CK.A, 1, `emit:0`);
  net.setTimer(CK.B, 1, `emit:0`);
  net.setTimer(CK.JM, cfg.firstCheckpoint, `trigger:0`);
  if (cfg.crashAt !== null) net.setTimer(CK.JM, cfg.crashAt, "crash");
  frame();
  // One frame per event that changed the caption, so a stepper can walk through the run.
  for (let i = 0; i < 20000 && net.step(); i++) if (caption !== frames[frames.length - 1]!.caption) frame();
  let dup = 0;
  for (const v of sink.values()) if (v > 1) dup += v - 1;
  return { cfg, net, frames, final: { cA: op.cA, cB: op.cB, sinkGot, sinkDup: dup }, completed, restoredFrom };
}
