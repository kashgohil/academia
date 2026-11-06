/**
 * Three-phase commit (Skeen, "Nonblocking Commit Protocols", SIGMOD 1981), simplified, on the shared network.
 *
 * Node 0 is the coordinator; nodes 1..n are participants.
 * - CANCOMMIT: the coordinator asks; a participant votes YES and becomes "uncertain".
 * - PRECOMMIT: when every vote is YES, the coordinator tells everyone that the decision will be commit. A participant
 *   becomes "precommitted" and acknowledges.
 * - DOCOMMIT: when the acknowledgements are in, or their timeout passes, the coordinator commits and says so.
 *
 * The extra phase means that no participant can be committed while another is still uncertain. So the survivors
 * can always decide: when a participant times out, it asks the others for their states (STATEREQ) and applies the
 * termination rule. Any committed → commit. Any aborted → abort. Any precommitted → commit. All uncertain → abort.
 *
 * The rule is correct when a silent node is a crashed node. In a partition, a silent node is alive on the other
 * side, and each side applies the rule to the states it can see. The two sides can decide differently.
 */
import { Net, type NetConfig, type NodeId } from "../net";

export type T3State = "init" | "uncertain" | "precommitted" | "committed" | "aborted";
export type T3Msg =
  | { k: "cancommit" }
  | { k: "yes" }
  | { k: "precommit" }
  | { k: "ackpre" }
  | { k: "docommit" }
  | { k: "abort" }
  | { k: "statereq" }
  | { k: "state"; s: T3State };

export const t3Label = (p: T3Msg) => (p.k === "state" ? p.s.toUpperCase() : p.k.toUpperCase());

export interface T3Cfg {
  participants: number;
  /** A participant that hears nothing for this long starts the termination protocol (ms). */
  timeout: number;
  /** How long a terminating participant collects states before it decides (ms). */
  collect: number;
  net: Partial<NetConfig>;
}

export const DEFAULT_T3: T3Cfg = { participants: 3, timeout: 80, collect: 40, net: { seed: 1, latency: { min: 10, max: 10 } } };

export class ThreePc {
  readonly cfg: T3Cfg;
  readonly net: Net<T3Msg>;
  readonly state: T3State[];
  readonly decidedAt: (number | undefined)[];
  private votes = new Set<NodeId>();
  private acks = new Set<NodeId>();
  private heard: Map<NodeId, T3State>[];
  private timers: number[];
  /** Called before each PRECOMMIT send. Returning false stops the broadcast (the coordinator died during it). */
  beforePrecommit?: (to: NodeId) => boolean;

  constructor(cfg: Partial<T3Cfg> = {}) {
    this.cfg = { ...DEFAULT_T3, ...cfg, net: { ...DEFAULT_T3.net, ...cfg.net } };
    const n = this.cfg.participants + 1;
    this.net = new Net<T3Msg>(n, this.cfg.net, {
      onMessage: (to, m) => this.onMsg(to, m.from, m.payload),
      onTimer: (node, tag) => this.onTimer(node, tag),
    });
    this.state = new Array<T3State>(n).fill("init");
    this.decidedAt = new Array<number | undefined>(n).fill(undefined);
    this.heard = Array.from({ length: n }, () => new Map());
    this.timers = new Array<number>(n).fill(0);
  }

  start() {
    for (let i = 1; i < this.net.n; i++) this.net.send(0, i, { k: "cancommit" });
  }

  private arm(i: NodeId, delay: number, tag: string) {
    this.net.cancelTimer(this.timers[i]!);
    this.timers[i] = this.net.setTimer(i, delay, tag);
  }

  private set(i: NodeId, s: T3State) {
    if (this.state[i] === s) return;
    this.state[i] = s;
    if (s === "committed" || s === "aborted") {
      this.decidedAt[i] ??= this.net.now;
      this.net.cancelTimer(this.timers[i]!);
    }
  }

  private onMsg(to: NodeId, from: NodeId, p: T3Msg) {
    const s = this.state[to]!;
    const done = s === "committed" || s === "aborted";
    if (to === 0) {
      if (p.k === "yes" && s === "init") {
        this.votes.add(from);
        if (this.votes.size === this.net.n - 1) {
          this.set(0, "precommitted");
          for (let i = 1; i < this.net.n; i++) {
            if (this.beforePrecommit && !this.beforePrecommit(i)) return;
            this.net.send(0, i, { k: "precommit" });
          }
          this.arm(0, this.cfg.timeout, "acks");
        }
      } else if (p.k === "ackpre" && s === "precommitted") {
        this.acks.add(from);
        if (this.acks.size === this.net.n - 1) this.coordCommit();
      }
      return;
    }
    if (p.k === "statereq") return void this.net.send(to, from, { k: "state", s });
    if (p.k === "state") return void this.heard[to]!.set(from, p.s);
    if (done) return;
    if (p.k === "cancommit") {
      this.set(to, "uncertain");
      this.net.send(to, 0, { k: "yes" });
      this.arm(to, this.cfg.timeout, "silence");
    } else if (p.k === "precommit") {
      this.set(to, "precommitted");
      this.net.send(to, 0, { k: "ackpre" });
      this.arm(to, this.cfg.timeout, "silence");
    } else if (p.k === "docommit") this.set(to, "committed");
    else if (p.k === "abort") this.set(to, "aborted");
  }

  private coordCommit() {
    this.set(0, "committed");
    for (let i = 1; i < this.net.n; i++) this.net.send(0, i, { k: "docommit" });
  }

  private onTimer(i: NodeId, tag: string) {
    if (i === 0) {
      // Acks missing: the silent participants are taken as crashed. Every vote was YES, so commit.
      if (tag === "acks" && this.state[0] === "precommitted") this.coordCommit();
      return;
    }
    const s = this.state[i]!;
    if (s === "committed" || s === "aborted") return;
    if (tag === "silence") {
      this.heard[i] = new Map();
      for (let j = 1; j < this.net.n; j++) if (j !== i) this.net.send(i, j, { k: "statereq" });
      this.arm(i, this.cfg.collect, "decide");
    } else if (tag === "decide") {
      const seen = [s, ...this.heard[i]!.values()];
      const d = seen.includes("committed") ? "committed" : seen.includes("aborted") ? "aborted" : seen.includes("precommitted") ? "committed" : "aborted";
      this.set(i, d);
    }
  }

  /** The participants' final states. */
  outcomes(): T3State[] {
    return this.state.slice(1);
  }
  /** True if two participants reached different decisions. */
  split(): boolean {
    const o = this.outcomes();
    return o.includes("committed") && o.includes("aborted");
  }
}

export type T3Scenario = "none" | "crash" | "partition";

/**
 * The scripted runs of the lesson. The coordinator sends PRECOMMIT to P1, P2, P3 in turn. In "crash" it dies right
 * after the first send, so only P1 is precommitted. In "partition" a cut separates {C, P1} from {P2, P3} at that
 * moment, so the other two PRECOMMITs are lost on the way.
 */
export function threePcScenario(kind: T3Scenario, cfg: Partial<T3Cfg> = {}) {
  const x = new ThreePc(cfg);
  x.beforePrecommit = (to) => {
    if (kind === "none" || to === 1) return true;
    if (kind === "crash") {
      if (x.net.isUp(0)) x.net.crash(0);
      return false;
    }
    if (to === 2) x.net.partition([[0, 1], [2, 3]]);
    return true;
  };
  x.start();
  x.net.runUntil(1000);
  return x;
}
