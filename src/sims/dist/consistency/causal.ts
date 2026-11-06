/**
 * A causal violation across three data centers, and the fix with dependency metadata (as in COPS), on the shared Net.
 *
 * Alice posts a question Q at DC1. DC1 replicates it to DC2 and DC3, but the link to DC3 is slow: DC1 holds the copy
 * for DC3 `qDelay` ms. Bob, at DC2, reads Q as soon as it arrives and posts a reply R there. DC2 replicates R. Carol
 * reads at DC3.
 * - Without metadata, DC3 shows R as soon as it arrives, so Carol can see the reply before the question.
 * - With metadata, R carries "depends on Q". DC3 keeps R hidden until it has Q (the dependency check of COPS).
 */
import { Net } from "../net";

export interface CausalConfig { seed: number; qDelay: number; causal: boolean; tEnd: number }
export const DEFAULT_CAUSAL: CausalConfig = { seed: 2, qDelay: 60, causal: false, tEnd: 140 };

type CMsg = { item: "Q" | "R"; deps: ("Q" | "R")[] };
export const DC_NAMES = ["DC1 (Alice)", "DC2 (Bob)", "DC3 (Carol)"];

export interface CausalRun {
  cfg: CausalConfig;
  net: Net<CMsg>;
  /** What each data center shows over time: [time, items]. */
  visible: [number, string[]][][];
  /** When R arrived at DC3 but was held back, and until when. */
  held: { from: number; until: number } | null;
  /** The span in which DC3 shows R but not Q (the anomaly), or null. */
  anomaly: { from: number; until: number } | null;
  /** When Q and R became visible at DC3. */
  qAt3: number;
  rAt3: number;
}

export function runCausal(partial: Partial<CausalConfig> = {}): CausalRun {
  const cfg = { ...DEFAULT_CAUSAL, ...partial };
  const shown: Set<string>[] = [new Set(), new Set(), new Set()];
  const pending: CMsg[][] = [[], [], []];
  const visible: [number, string[]][][] = [[[0, []]], [[0, []]], [[0, []]]];
  let held: CausalRun["held"] = null;
  const show = (dc: number, item: string, now: number) => {
    shown[dc]!.add(item);
    visible[dc]!.push([now, ["Q", "R"].filter((x) => shown[dc]!.has(x))]);
  };
  const tryApply = (dc: number, now: number) => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const m of [...pending[dc]!]) {
        if (m.deps.every((d) => shown[dc]!.has(d))) {
          pending[dc]!.splice(pending[dc]!.indexOf(m), 1);
          show(dc, m.item, now);
          if (dc === 2 && m.item === "R" && held) held.until = now;
          changed = true;
        }
      }
    }
  };
  const net = new Net<CMsg>(3, { seed: cfg.seed, latency: { min: 8, max: 14 } }, {
    onMessage(dc, msg, net) {
      const m = msg.payload;
      pending[dc]!.push(m);
      if (dc === 2 && m.item === "R" && !m.deps.every((d) => shown[2]!.has(d))) held = { from: net.now, until: Infinity };
      tryApply(dc, net.now);
      // Bob reads the question at DC2 and replies at once (after 5 ms of typing).
      if (dc === 1 && m.item === "Q") net.setTimer(1, 5, "reply");
    },
    onTimer(_dc, tag, net) {
      if (tag === "post") {
        show(0, "Q", net.now);
        net.send(0, 1, { item: "Q", deps: [] });
        net.setTimer(0, cfg.qDelay, "slowlink");
      } else if (tag === "slowlink") net.send(0, 2, { item: "Q", deps: [] });
      else if (tag === "reply") {
        show(1, "R", net.now);
        const deps: ("Q" | "R")[] = cfg.causal ? ["Q"] : [];
        net.send(1, 0, { item: "R", deps });
        net.send(1, 2, { item: "R", deps });
      }
    },
  });
  net.setTimer(0, 5, "post");
  net.runAll();
  const at = (item: string) => visible[2]!.find(([, xs]) => xs.includes(item))?.[0] ?? Infinity;
  const qAt3 = at("Q"), rAt3 = at("R");
  return { cfg, net, visible, held, anomaly: rAt3 < qAt3 ? { from: rAt3, until: qAt3 } : null, qAt3, rAt3 };
}
