/**
 * Ben-Or's randomized binary consensus (PODC 1983), crash version, on the shared network.
 * n processes, at most f crash, n > 2f. Each process waits for n − f messages in each phase.
 *
 *   phase 1: send (R, r, x). If more than n/2 of the reports carry the same v, propose v, else propose ⊥.
 *   phase 2: send (P, r, proposal). If at least f + 1 proposals carry v, decide v.
 *            If at least one carries v, set x = v. Otherwise set x to a fair coin flip.
 *
 * Safety never depends on the coin. The coin only gives termination: in each round, all processes pick the same
 * value with a probability bounded away from 0, so the chance to still be undecided after r rounds shrinks
 * geometrically. A process that decided keeps taking part, so that the others can still collect n − f messages.
 */
import { Net } from "../../net";
import type { Bit, Prop } from "./valence";

export interface BenOrMsg {
  ph: 1 | 2;
  r: number;
  v: Prop;
}

export interface BenOrConfig {
  n: number;
  /** Crash faults the protocol must survive; it waits for n − f messages. */
  f: number;
  /** How many processes really crash, at random times in the first rounds. At most f. */
  crashes: number;
  /** Number of processes that start with 1; the rest start with 0. */
  ones: number;
  seed: number;
  latency: { min: number; max: number };
  /** Give up after this many rounds (only to bound a run; it is never reached in practice). */
  maxRounds: number;
}

export const BENOR_DEFAULTS: BenOrConfig = { n: 5, f: 2, crashes: 0, ones: 2, seed: 1, latency: { min: 5, max: 15 }, maxRounds: 200 };

export interface BenOrResult {
  /** The round in which each process decided, or null (crashed or never). */
  decidedIn: (number | null)[];
  values: (Bit | null)[];
  /** The round in which the last live process decided. */
  rounds: number;
  agreement: boolean;
  messages: number;
  coinFlips: number;
  /** For each process, its estimate at the start of each round, and whether a coin set it. */
  history: { x: Bit; coin: boolean }[][];
  net: Net<BenOrMsg>;
}

export function runBenOr(cfg: Partial<BenOrConfig> = {}): BenOrResult {
  const c = { ...BENOR_DEFAULTS, ...cfg };
  const { n, f } = c;
  const x: Bit[] = Array.from({ length: n }, (_, i) => (i < c.ones ? 1 : 0));
  const r = Array<number>(n).fill(1);
  const ph = Array<1 | 2>(n).fill(1);
  const mine: Prop[] = [...x];
  const dec: (Bit | null)[] = Array(n).fill(null);
  const decidedIn: (number | null)[] = Array(n).fill(null);
  // inbox[i] maps "r/ph" to the values received from distinct senders.
  const inbox: Map<string, Map<number, Prop>>[] = Array.from({ length: n }, () => new Map());
  let coinFlips = 0;
  const history: { x: Bit; coin: boolean }[][] = x.map((v) => [{ x: v, coin: false }]);
  const crashed = new Set<number>();
  let maxRound = 0;

  const net: Net<BenOrMsg> = new Net<BenOrMsg>(n, { seed: c.seed, latency: c.latency }, {
    onMessage: (to, m, nt) => {
      const k = `${m.payload.r}/${m.payload.ph}`;
      const box = inbox[to]!.get(k) ?? new Map<number, Prop>();
      box.set(m.from, m.payload.v);
      inbox[to]!.set(k, box);
      advance(to, nt);
    },
    onTimer: (node, tag, nt) => {
      if (tag === "crash") nt.crash(node);
    },
  });

  const send = (i: number, nt: Net<BenOrMsg>) => {
    const box = inbox[i]!.get(`${r[i]}/${ph[i]}`) ?? new Map<number, Prop>();
    box.set(i, mine[i]!);
    inbox[i]!.set(`${r[i]}/${ph[i]}`, box);
    nt.broadcast(i, { ph: ph[i]!, r: r[i]!, v: mine[i]! });
  };

  function advance(i: number, nt: Net<BenOrMsg>) {
    for (;;) {
      if (r[i]! > c.maxRounds) return;
      const box = inbox[i]!.get(`${r[i]}/${ph[i]}`);
      if (!box || box.size < n - f) return;
      const vals = [...box.values()].slice(0, n - f);
      inbox[i]!.delete(`${r[i]}/${ph[i]}`);
      if (ph[i] === 1) {
        const ones = vals.filter((v) => v === 1).length, zeros = vals.filter((v) => v === 0).length;
        mine[i] = ones > n / 2 ? 1 : zeros > n / 2 ? 0 : null;
        ph[i] = 2;
      } else {
        const ones = vals.filter((v) => v === 1).length, zeros = vals.filter((v) => v === 0).length;
        const v: Prop = ones > 0 ? 1 : zeros > 0 ? 0 : null;
        const count = v === 1 ? ones : zeros;
        if (v !== null && count >= f + 1 && dec[i] === null) {
          dec[i] = v;
          decidedIn[i] = r[i]!;
          maxRound = Math.max(maxRound, r[i]!);
        }
        if (v !== null) x[i] = v;
        else {
          x[i] = nt.random() < 0.5 ? 0 : 1;
          coinFlips++;
        }
        history[i]!.push({ x: x[i]!, coin: v === null });
        r[i]! += 1;
        ph[i] = 1;
        mine[i] = x[i]!;
        if (allLiveDecided()) return;
      }
      send(i, nt);
    }
  }

  const allLiveDecided = () => dec.every((d, i) => d !== null || crashed.has(i));

  // Pick the processes that crash and when: somewhere in the first two rounds.
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(net.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (const i of order.slice(0, Math.min(c.crashes, f))) {
    crashed.add(i);
    net.setTimer(i, net.random() * 4 * c.latency.max, "crash");
  }
  for (let i = 0; i < n; i++) send(i, net);
  for (let guard = 0; guard < 5e6 && !allLiveDecided(); guard++) if (!net.step()) break;

  const vals = new Set(dec.filter((d) => d !== null));
  return { decidedIn, values: dec, rounds: maxRound, agreement: vals.size <= 1, messages: net.messages.length, coinFlips, history, net };
}

/** Rounds to decide over many seeds, for a histogram. */
export function benOrSweep(cfg: Partial<BenOrConfig>, seeds: number, firstSeed = 1): number[] {
  const out: number[] = [];
  for (let s = 0; s < seeds; s++) out.push(runBenOr({ ...cfg, seed: firstSeed + s }).rounds);
  return out;
}
