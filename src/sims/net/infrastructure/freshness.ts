/**
 * One popular object at one edge, on PacketNet: expiry (max-age), the thundering herd, request collapsing,
 * stale-while-revalidate and stale-if-error (RFC 5861), and an origin outage.
 *
 * Users send requests to the edge as a Poisson stream. The edge answers from its copy while the copy is fresh.
 * When the copy is stale:
 * - within `swr` seconds after expiry, the edge answers with the stale copy at once and revalidates in the background
 *   (one fetch at a time);
 * - otherwise the request waits for a fetch from the origin. With `collapse`, all waiting requests share one fetch.
 *   Without it, each waiting request sends its own fetch.
 * When a fetch fails (a 5xx), the edge answers with its stale copy if the copy is younger than max-age + `sie`;
 * otherwise the user gets the error.
 * The origin needs `originMs` to make the object (model input) and answers 503 at once during the outage.
 */
import { PacketNet } from "../packet";
import { mulberry32 } from "../../rng";

export type Outcome = "hit" | "stale" | "miss" | "stale-error" | "error";
export const OUTCOMES: Outcome[] = ["hit", "stale", "miss", "stale-error", "error"];

type Msg =
  | { k: "req"; id: number }
  | { k: "resp"; id: number; outcome: Outcome }
  | { k: "fetch"; fid: number }
  | { k: "fresh"; fid: number; ok: boolean; born: number };

export interface FreshOpts {
  /** User requests per second (model input). */
  rate?: number;
  /** max-age, s. */
  ttl?: number;
  /** stale-while-revalidate, s (0: off). */
  swr?: number;
  /** stale-if-error, s (0: off). */
  sie?: number;
  collapse?: boolean;
  /** Origin time to build the response, ms (model input). */
  originMs?: number;
  /** One-way delays, ms (model inputs). */
  userDelay?: number;
  originDelay?: number;
  /** Origin outage [from, to), s; null: none. */
  outage?: [number, number] | null;
  duration?: number;
  seed?: number;
}

export interface FreshRequest {
  t: number;
  latency: number;
  outcome: Outcome;
}

export interface FreshResult {
  requests: FreshRequest[];
  /** Times (s) when the origin received a fetch. */
  fetches: number[];
  counts: Record<Outcome, number>;
  /** The largest number of origin fetches in any one 1-second window that starts at an expiry. */
  maxBurst: number;
}

export function freshRun(o: FreshOpts = {}): FreshResult {
  const rate = o.rate ?? 200, ttl = (o.ttl ?? 10) * 1000, swr = (o.swr ?? 0) * 1000, sie = (o.sie ?? 0) * 1000;
  const collapse = o.collapse ?? false, originMs = o.originMs ?? 100;
  const dur = (o.duration ?? 60) * 1000;
  const outage: [number, number] | null = o.outage === undefined ? [30, 45] : o.outage;
  const U = 0, E = 1, O = 2;
  const net = new PacketNet<Msg>(["users", "edge", "origin"], { seed: o.seed ?? 1, record: false });
  net.connect(U, E, { rate: 1e9, delay: o.userDelay ?? 5 });
  net.connect(E, O, { rate: 1e9, delay: o.originDelay ?? 40 });
  net.computeRoutes();

  const sentAt = new Map<number, number>();
  const requests: FreshRequest[] = [];
  const fetches: number[] = [];
  let copy: { born: number } | null = null;
  let nextFid = 1;
  const waiters = new Map<number, number[]>(); // fetch id → request ids
  let shared: number | null = null; // the fetch that new waiters join (collapse) or the background revalidation
  let background: number | null = null;
  const pendingOrigin = new Map<string, { fid: number; ok: boolean }>();

  const answer = (id: number, outcome: Outcome) => net.send(E, U, 1400, { k: "resp", id, outcome });
  const fetch = (ids: number[]) => {
    const fid = nextFid++;
    waiters.set(fid, ids);
    net.send(E, O, 300, { k: "fetch", fid });
    return fid;
  };
  const inOutage = (t: number) => outage !== null && t >= outage[0] * 1000 && t < outage[1] * 1000;

  net.setHandlers({
    onDeliver: (node, pkt) => {
      const m = pkt.payload;
      if (node === E && m.k === "req") {
        const age = copy ? net.now - copy.born : Infinity;
        if (age < ttl) return answer(m.id, "hit");
        if (age < ttl + swr) {
          answer(m.id, "stale");
          if (background === null) background = fetch([]);
          return;
        }
        if (collapse && shared !== null) { waiters.get(shared)!.push(m.id); return; }
        const fid = fetch([m.id]);
        if (collapse) shared = fid;
        return;
      }
      if (node === O && m.k === "fetch") {
        fetches.push(net.now / 1000);
        const ok = !inOutage(net.now);
        const tag = `o${m.fid}`;
        pendingOrigin.set(tag, { fid: m.fid, ok });
        net.setTimer(O, ok ? originMs : 1, tag);
        return;
      }
      if (node === E && m.k === "fresh") {
        const ids = waiters.get(m.fid) ?? [];
        waiters.delete(m.fid);
        if (shared === m.fid) shared = null;
        if (background === m.fid) background = null;
        if (m.ok) {
          copy = { born: m.born };
          for (const id of ids) answer(id, "miss");
        } else {
          const usable = copy !== null && net.now - copy.born < ttl + sie;
          for (const id of ids) answer(id, usable ? "stale-error" : "error");
        }
        return;
      }
      if (node === U && m.k === "resp") {
        const t0 = sentAt.get(m.id)!;
        requests.push({ t: t0 / 1000, latency: net.now - t0, outcome: m.outcome });
      }
    },
    onTimer: (node, tag) => {
      const p = pendingOrigin.get(tag);
      if (node !== O || !p) return;
      pendingOrigin.delete(tag);
      net.send(O, E, 1400, { k: "fresh", fid: p.fid, ok: p.ok, born: net.now });
    },
  });

  const rng = mulberry32(o.seed ?? 1);
  let t = 0, id = 0;
  for (;;) {
    t += (-Math.log(1 - rng()) / rate) * 1000;
    if (t >= dur) break;
    const rid = id++;
    net.at(t, () => {
      sentAt.set(rid, net.now);
      net.send(U, E, 300, { k: "req", id: rid });
    });
  }
  net.runAll(5_000_000);
  requests.sort((a, b) => a.t - b.t);
  const counts = Object.fromEntries(OUTCOMES.map((x) => [x, 0])) as Record<Outcome, number>;
  for (const r of requests) counts[r.outcome]++;
  // The herd: fetches within 1 s after each fetch that starts a burst.
  let maxBurst = 0;
  for (let i = 0, j = 0; i < fetches.length; i++) {
    while (fetches[j]! < fetches[i]! - 1) j++;
    maxBurst = Math.max(maxBurst, i - j + 1);
  }
  return { requests, fetches, counts, maxBurst };
}

/**
 * The expected size of a thundering herd without collapsing: every request that reaches the edge between the expiry
 * and the return of the first fetch sends its own fetch. The window is the edge–origin round trip plus the origin's
 * work, so the herd is about rate × window.
 */
export const herdExpected = (rate: number, originDelayMs = 40, originMs = 100) => (rate * (2 * originDelayMs + originMs)) / 1000;
