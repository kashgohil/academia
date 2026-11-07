/** Demos for "CDNs": where the time goes with an edge, hit ratio against cache size, a shield in front of the
 *  origin, and one hot object through expiry, a thundering herd and an origin outage. */
import { useMemo } from "react";
import {
  Banner, Canvas2D, Demo, Dots, Legend, Line, Meter, MiniTable, Note, Param, Plot, RuleX, Stats, cssVar, fixed, int, ms, pct, range, seg, select,
  toggle, useChunked, useParams, useWidth,
} from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { fromPackets } from "./PacketViews";
import { CITIES, fiberRttMs } from "../../sims/net/foundations";
import {
  CDN_NODES, CDN_PATHS, CDN_PATH_LABEL, OUTCOMES, cdnLatencyRun, cheLru, freshRun, hitRatio, makeCache, objectProbs, staticHit, tierRun, zipfStream,
  type CachePolicy, type CdnPath, type Outcome, type TlsVersion,
} from "../../sims/net/infrastructure";

// ============================================================================ 1. Where the time goes

const CITY_OPTS = CITIES.map((c) => ({ value: c.id, label: c.name }));
const LAT = {
  edgeRtt: range({ label: "Round trip to the nearest edge (model input)", min: 2, max: 40, step: 1, default: 10, format: (v) => `${v} ms` }),
  client: select<string>({ label: "Client in", options: CITY_OPTS, default: "syd" }),
  origin: select<string>({ label: "Origin in", options: CITY_OPTS, default: "nyc" }),
  path: seg<CdnPath>("Path", [["direct", "no CDN"], ["hit", "edge hit"], ["miss-warm", "miss, warm"], ["miss-cold", "miss, cold"]], "hit"),
  tls: seg<TlsVersion>("TLS", [["1.3", "1.3"], ["1.2", "1.2"]], "1.3"),
};

/** Labels for a narrow screen. */
const TINY: Record<string, string> = { "SYN-ACK": "SA", SYN: "S", Hello: "CH", "Hello…Fin": "SH", "Fin, GET": "GET", "Hello, Cert": "SH", "Key, Fin": "Fin" };

export function NetInfraCdnLatencyDemo() {
  const P = useParams("net-infra-cdnlat", LAT);
  const { edgeRtt, client, origin, path, tls } = P.values;
  const originRtt = client === origin ? 2 : fiberRttMs(client, origin);
  const run = useMemo(() => cdnLatencyRun({ path, tls, edgeRtt, originRtt }), [path, tls, edgeRtt, originRtt]);
  const all = useMemo(() => CDN_PATHS.map((p) => ({ p, t: cdnLatencyRun({ path: p, tls, edgeRtt, originRtt, record: false }).ttfbMs })), [tls, edgeRtt, originRtt]);
  const [ref, width] = useWidth<HTMLDivElement>();
  const st = fromPackets(run.net, {
    label: (p) => (width < 520 ? TINY[p.payload.label] ?? p.payload.label : p.payload.label),
    color: (p) => (p.src === CDN_NODES.client ? "var(--c1)" : p.src === CDN_NODES.origin ? "var(--c5)" : "var(--c2)"),
  });
  const max = Math.max(...all.map((a) => a.t));
  return (
    <Demo title="Time to the first byte, with and without an edge"
      controls={<>
        <Param spec={LAT.edgeRtt} value={edgeRtt} onChange={(v) => P.set("edgeRtt", v as number)} />
        <Param spec={LAT.client} value={client} onChange={(v) => P.set("client", v as string)} />
        <Param spec={LAT.origin} value={origin} onChange={(v) => P.set("origin", v as string)} />
        <Param spec={LAT.path} value={path} onChange={(v) => P.set("path", v as CdnPath)} />
        <Param spec={LAT.tls} value={tls} onChange={(v) => P.set("tls", v as TlsVersion)} />
      </>}
    >
      <div ref={ref}><SpaceTime nodes={st.names} tEnd={run.ttfbMs * 1.04} messages={st.messages} marks={st.marks} rowHeight={54} /></div>
      <Legend items={[{ label: "from the client", color: "var(--c1)" }, { label: "from the edge", color: "var(--c2)" }, { label: "from the origin", color: "var(--c5)" }]} />
      <div style={{ marginTop: 8 }}>
        {all.map((a) => (
          <Meter key={a.p} label={CDN_PATH_LABEL[a.p]} value={a.t} max={max} color={a.p === path ? "var(--c1)" : "var(--faint)"} text={ms(a.t)} />
        ))}
      </div>
      <Banner tone={path === "hit" ? "good" : path === "direct" ? "bad" : "plain"}>
        {path === "direct" ? `Every handshake round trip crosses the whole path: ${fixed(edgeRtt + originRtt, 0)} ms each.`
          : path === "hit" ? `All round trips stay between the client and the edge. The far origin is not on the path at all.`
          : path === "miss-warm" ? `The handshakes stay short. The miss costs one round trip to the origin, because the edge reuses an open connection.`
          : `The edge must open TCP and TLS to the origin first: the miss costs as much as no CDN.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "first byte", value: ms(run.ttfbMs) },
          { label: "edge round trip", value: ms(edgeRtt) },
          { label: "edge to origin round trip (fiber, lower bound)", value: ms(originRtt) },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. Hit ratio against cache size

const HIT = {
  size: range({ label: "Cache size (objects)", min: 10, max: 10000, step: 1, default: 1000, log: true, format: (v) => int(v) }),
  theta: range({ label: "Zipf exponent θ", min: 0.6, max: 1.2, step: 0.05, default: 0.8, format: (v) => fixed(v) }),
  variants: seg<string>("Cache-key variants per URL", [["1", "1"], ["2", "2"], ["10", "10"], ["50", "50"]], "1"),
};
const K = 10_000;
const SIZES = [10, 30, 100, 300, 1000, 3000, 10000];
const POLICY_COLOR = { lru: "var(--c1)", fifo: "var(--c2)", lfu: "var(--c3)", static: "var(--c5)" } as const;

export function NetInfraCdnHitDemo() {
  const P = useParams("net-infra-cdnhit", HIT);
  const { size, theta, variants } = P.values;
  const V = Number(variants);
  const C = Math.round(size);
  const key = `${theta}-${V}`;
  const jobs = useMemo(() => {
    const stream = zipfStream({ K, theta, variants: V, requests: 100_000 });
    return SIZES.flatMap((c) => (["lru", "fifo", "lfu"] as CachePolicy[]).map((p) => () => ({ p, c, h: hitRatio(stream, makeCache(p, c)) })));
  }, [theta, V]);
  const sims = useChunked(`net-infra-hit-${key}`, jobs, { keep: true }).filter((x): x is NonNullable<typeof x> => !!x);
  const probs = useMemo(() => objectProbs(K, theta), [theta]);
  const curve = useMemo(() => Array.from({ length: 25 }, (_, i) => Math.round(10 * Math.pow(1000, i / 24))).map((c) => [c, cheLru(probs, c, V).hit] as const), [probs, V]);
  const statics = useMemo(() => curve.map(([c]) => [c, staticHitV(probs, c, V)] as const), [curve, probs, V]);
  const che = cheLru(probs, C, V).hit;
  return (
    <Demo title="Hit ratio against cache size, 10,000 URLs"
      controls={<>
        <Param spec={HIT.size} value={size} onChange={(v) => P.set("size", v as number)} />
        <Param spec={HIT.theta} value={theta} onChange={(v) => P.set("theta", v as number)} />
        <Param spec={HIT.variants} value={variants} onChange={(v) => P.set("variants", v as string)} />
      </>}
    >
      <Plot x={[10, 10000]} y={[0, 1]} logX height={240} xLabel="cache size (objects)" yLabel="hit ratio" xTicks={[10, 100, 1000, 10000]} xFormat={(v) => int(v)} yFormat={(v) => pct(v, 0)}>
        <RuleX at={C} color="var(--fg)" />
        <Line points={statics} color={POLICY_COLOR.static} dash="5 4" />
        <Line points={curve} color="var(--muted)" width={1.5} dash="2 3" />
        {(["lru", "fifo", "lfu"] as const).map((p) => <Dots key={p} r={3.5} color={POLICY_COLOR[p]} points={sims.filter((s) => s.p === p).map((s) => [s.c, s.h] as const)} />)}
      </Plot>
      <Legend items={[{ label: "LRU (simulated)", color: POLICY_COLOR.lru }, { label: "FIFO", color: POLICY_COLOR.fifo }, { label: "LFU", color: POLICY_COLOR.lfu }, { label: "Che's formula for LRU", color: "var(--muted)" }, { label: "ideal: the C most popular", color: POLICY_COLOR.static }]} />
      <Banner tone="plain">
        At {int(C)} objects, LRU hits {pct(che)} by Che's formula; the ideal static cache hits {pct(staticHitV(probs, C, V))}.
        {V > 1 ? ` With ${V} variants of every URL, each copy is ${V} times less popular, and the same cache holds ${V} times fewer URLs.` : ""}
      </Banner>
      <Note>Each dot is a simulation of 100,000 requests (the first 30% warm the cache). Objects have equal size. The catalog is fixed: the model leaves out new objects and popularity that changes over time.</Note>
    </Demo>
  );
}

/** The ideal static hit ratio when each URL has V equally likely variants. */
function staticHitV(probs: Float64Array, C: number, V: number) {
  const whole = Math.floor(C / V);
  return staticHit(probs, whole) + (whole < probs.length ? (probs[whole]! * (C - whole * V)) / V : 0);
}

// ============================================================================ 3. Edges and a shield

const TIER = {
  edgeSize: range({ label: "Objects per edge", min: 500, max: 10000, step: 500, default: 5000 }),
  ttl: range({ label: "max-age", min: 10, max: 600, step: 10, default: 60, format: (v) => `${v} s` }),
  shield: range({ label: "Objects in the shield", min: 1000, max: 10000, step: 500, default: 10000 }),
};
const EDGES = [1, 2, 4, 8, 16, 32, 64];

export function NetInfraCdnTierDemo() {
  const P = useParams("net-infra-cdntier", TIER);
  const { edgeSize, ttl, shield } = P.values;
  const jobs = useMemo(() => EDGES.flatMap((e) => [0, shield].map((sh) => () => ({ e, sh, r: tierRun({ K, theta: 0.8, edges: e, edgeSize, shieldSize: sh, ttl, requests: 100_000 }) }))), [edgeSize, ttl, shield]);
  const res = useChunked(`net-infra-tier-${edgeSize}-${ttl}-${shield}`, jobs, { keep: true }).filter((x): x is NonNullable<typeof x> => !!x);
  const line = (withShield: boolean) => res.filter((x) => (x.sh > 0) === withShield).map((x) => [x.e, x.r.originRate] as const);
  const at = (e: number, s: boolean) => res.find((x) => x.e === e && (x.sh > 0) === s)?.r;
  const a = at(64, false), b = at(64, true);
  return (
    <Demo title="Origin load as the CDN adds edges"
      controls={<>
        <Param spec={TIER.edgeSize} value={edgeSize} onChange={(v) => P.set("edgeSize", v as number)} />
        <Param spec={TIER.ttl} value={ttl} onChange={(v) => P.set("ttl", v as number)} />
        <Param spec={TIER.shield} value={shield} onChange={(v) => P.set("shield", v as number)} />
      </>}
    >
      <Plot x={[1, 64]} y={[0, 1000]} logX height={220} xLabel="edge servers" yLabel="origin requests per second" xTicks={EDGES} xFormat={(v) => String(v)}>
        <Line points={line(false)} color="var(--c4)" />
        <Dots points={line(false)} color="var(--c4)" />
        <Line points={line(true)} color="var(--c3)" />
        <Dots points={line(true)} color="var(--c3)" />
      </Plot>
      <Legend items={[{ label: "edges go to the origin", color: "var(--c4)" }, { label: "edges go to a shield", color: "var(--c3)" }]} />
      {a && b && (
        <MiniTable head={["64 edges", "edge hit ratio", "shield answers", "origin requests/s"]}
          rows={[["no shield", pct(a.edgeHit), "–", int(a.originRate)], ["shield", pct(b.edgeHit), pct(b.shieldHit), int(b.originRate)]]} />
      )}
      <Note>Model inputs: 1,000 user requests per second over 10,000 URLs (Zipf, θ = 0.8), spread over the edges at random; LRU caches with expiry. A copy that the shield passes on keeps its age, so it expires at the edge when it expires at the shield.</Note>
    </Demo>
  );
}

// ============================================================================ 4. One hot object

const FR = {
  rate: range({ label: "Requests per second for the object", min: 20, max: 500, step: 10, default: 200 }),
  collapse: toggle({ label: "Collapse requests: one fetch per object at a time", default: false }),
  swr: range({ label: "stale-while-revalidate", min: 0, max: 60, step: 5, default: 0, format: (v) => (v ? `${v} s` : "off") }),
  sie: range({ label: "stale-if-error", min: 0, max: 120, step: 10, default: 0, format: (v) => (v ? `${v} s` : "off") }),
  outage: toggle({ label: "The origin fails from 30 s to 45 s", default: false }),
};
const OUT_COLOR: Record<Outcome, string> = { hit: "--c3", stale: "--c1", miss: "--c2", "stale-error": "--c5", error: "--c4" };
const OUT_LABEL: Record<Outcome, string> = { hit: "fresh hit", stale: "stale, revalidating", miss: "waited for the origin", "stale-error": "stale because of an error", error: "error" };

const p99 = (q: { latency: number }[]) => { const a = q.map((x) => x.latency).sort((x, y) => x - y); return a[Math.floor(a.length * 0.99)] ?? 0; };

export function NetInfraCdnFreshDemo() {
  const P = useParams("net-infra-cdnfresh", FR);
  const { rate, collapse, swr, sie, outage } = P.values;
  const jobs = useMemo(() => [() => freshRun({ rate, collapse, swr, sie, outage: outage ? [30, 45] : null })], [rate, collapse, swr, sie, outage]);
  const r = useChunked(`net-infra-fresh-${rate}-${collapse}-${swr}-${sie}-${outage}`, jobs, { keep: true })[0];
  return (
    <Demo title="One object, max-age 10 s, for 60 seconds"
      controls={<>
        <Param spec={FR.rate} value={rate} onChange={(v) => P.set("rate", v as number)} />
        <Param spec={FR.collapse} value={collapse} onChange={(v) => P.set("collapse", v as boolean)} />
        <Param spec={FR.swr} value={swr} onChange={(v) => P.set("swr", v as number)} />
        <Param spec={FR.sie} value={sie} onChange={(v) => P.set("sie", v as number)} />
        <Param spec={FR.outage} value={outage} onChange={(v) => P.set("outage", v as boolean)} />
      </>}
    >
      <Canvas2D height={230} deps={[r, outage]} draw={(ctx, w, h) => {
        if (!r) return;
        const L = 34, R = 6, bin = 0.5, nb = 120;
        const x = (t: number) => L + (t / 60) * (w - L - R);
        const bw = (w - L - R) / nb;
        const fetch = new Array<number>(nb).fill(0);
        for (const f of r.fetches) fetch[Math.min(nb - 1, Math.floor(f / bin))]!++;
        const mix = Array.from({ length: nb }, () => Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>);
        for (const q of r.requests) mix[Math.min(nb - 1, Math.floor(q.t / bin))]![q.outcome]++;
        const fMax = Math.max(4, ...fetch);
        const top = 12, fh = 90, gap = 26, mh = h - top - fh - gap - 18;
        ctx.font = "11px system-ui";
        if (outage) { ctx.fillStyle = cssVar("--subtle"); ctx.fillRect(x(30), top, x(45) - x(30), h - top - 18); }
        ctx.fillStyle = cssVar("--muted");
        ctx.fillText(`origin fetches per 0.5 s (max ${fMax})`, L, top - 2);
        ctx.fillText("what users got", L, top + fh + gap - 4);
        ctx.fillStyle = cssVar("--fg");
        for (let i = 0; i < nb; i++) if (fetch[i]) { const bh = (fetch[i]! / fMax) * fh; ctx.fillRect(L + i * bw + 0.5, top + fh - bh, Math.max(1, bw - 1), bh); }
        const y0 = top + fh + gap;
        for (let i = 0; i < nb; i++) {
          const m = mix[i]!, n = OUTCOMES.reduce((a, o) => a + m[o], 0);
          let y = y0;
          for (const o of OUTCOMES) { if (!m[o]) continue; const hh = (m[o] / n) * mh; ctx.fillStyle = cssVar(OUT_COLOR[o]); ctx.fillRect(L + i * bw, y, bw + 0.3, hh); y += hh; }
        }
        ctx.fillStyle = cssVar("--muted");
        for (const t of [0, 10, 20, 30, 40, 50, 60]) ctx.fillText(`${t} s`, Math.min(x(t) - 6, w - 26), h - 4);
      }} />
      <Legend items={OUTCOMES.map((o) => ({ label: OUT_LABEL[o], color: `var(${OUT_COLOR[o]})` }))} />
      <Note>Top: requests that reached the origin. Bottom: the share of user requests in each half second by result. The shaded band is the outage.</Note>
      {r && (
        <>
          <Banner tone={r.counts.error ? "bad" : r.maxBurst > 3 ? "warn" : "good"}>
            The origin got {int(r.fetches.length)} fetches; the largest burst was {r.maxBurst} within one second.
            {r.counts.error ? ` ${int(r.counts.error)} users saw an error.` : " No user saw an error."}
          </Banner>
          <div style={{ marginTop: 10 }}>
            <Stats items={[...OUTCOMES.filter((o) => r.counts[o] > 0).map((o) => ({ label: OUT_LABEL[o], value: int(r.counts[o]) })), { label: "p99 user latency", value: ms(p99(r.requests)) }]} />
          </div>
        </>
      )}
      <Note>Model inputs: users 5 ms from the edge, the origin 40 ms further, 100 ms to build the response, a 503 at once during the outage.</Note>
    </Demo>
  );
}
