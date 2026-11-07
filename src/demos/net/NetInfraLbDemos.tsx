/** Demos for "Load balancers": forwarding modes on real packets, connections across changes, policies and tail
 *  latency, and a failing backend against health checks, outlier detection and retries. */
import { useMemo, useState } from "react";
import {
  Banner, Bars, Chip, Demo, Legend, Line, MiniTable, Note, Param, Plot, RuleX, SectionLabel, Stats, bytes, fixed, int, ms, pct, range, seg, sig, toggle,
  useChunked, useParams,
} from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { tcpSpaceTime } from "./NetTcpUi";
import {
  BUCKET_S, LB_CHANGE_LABEL, LB_MODE_LABEL, LBN, POLICIES, POLICY_LABEL, changeMatrix, changeRun, healthRun, lbHeaderRows, lbPathRun, policyRun,
  supermarketMean, type EcmpKind, type Fate, type LbChange, type LbMode, type Lookup, type Policy,
} from "../../sims/net/infrastructure";

// ============================================================================ 1. Forwarding modes

const MODES = {
  mode: seg<LbMode>("Mode", [["nat", "NAT"], ["dsr", "DSR"], ["tunnel", "IP-in-IP"], ["proxy", "full proxy"]], "nat"),
  resp: range({ label: "Response size", min: 2, max: 200, step: 1, default: 20, log: true, format: (v) => `${Math.round(v)} KB` }),
  pooled: toggle({ label: "Proxy keeps open connections to the backends (a pool)", default: true }),
};

const MODE_TEXT: Record<LbMode, string> = {
  nat: "The balancer rewrites the destination to the backend. The backend's replies must come back through the balancer, which rewrites the source to the VIP. Every byte crosses the balancer twice.",
  dsr: "The balancer changes only the destination MAC address. The backend owns the VIP on a loopback interface and answers the client directly. The balancer sees only the client's packets.",
  tunnel: "The balancer wraps each client packet in an outer IP header to the backend. The backend unwraps it and answers directly, as in DSR, but it can sit behind routers.",
  proxy: "The balancer ends the client's TCP connection and uses a second connection to the backend. It sees every byte and can read HTTP: this is what an L7 balancer must do.",
};

export function NetInfraLbModesDemo() {
  const P = useParams("net-infra-lbmodes", MODES);
  const { mode, resp, pooled } = P.values;
  const respBytes = Math.round(resp) * 1000;
  const run = useMemo(() => lbPathRun({ mode, respBytes, pooled }), [mode, respBytes, pooled]);
  const raw = tcpSpaceTime(run.net, { nodes: [LBN.client, LBN.router, LBN.lb, LBN.backend], labels: "control" });
  // Label only the hops on the client's link; the short data-center hops have no room for text.
  const st = { ...raw, messages: raw.messages.map((m) => (m.from === 0 || m.to === 0 ? m : { ...m, label: undefined })) };
  const rows = lbHeaderRows(mode);
  const share = run.lbBytes / run.wanBytes;
  return (
    <Demo title="One download through a load balancer"
      controls={<>
        <Param spec={MODES.mode} value={mode} onChange={(v) => P.set("mode", v as LbMode)} />
        <Param spec={MODES.resp} value={resp} onChange={(v) => P.set("resp", v as number)} />
        {mode === "proxy" && <Param spec={MODES.pooled} value={pooled} onChange={(v) => P.set("pooled", v as boolean)} />}
      </>}
    >
      <SpaceTime nodes={st.names} tEnd={Math.max(30, run.doneMs + run.startAt + 12)} tStart={0} messages={st.messages} marks={st.marks} rowHeight={50} />
      <Legend items={[{ label: "SYN", color: "var(--c2)" }, { label: "data", color: "var(--c1)" }, { label: "ACK", color: "var(--muted)" }]} />
      <Banner tone={share < 0.2 ? "good" : "plain"} label={LB_MODE_LABEL[mode]}>{MODE_TEXT[mode]}</Banner>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginTop: 10 }}>
        {(["request", "response"] as const).map((k) => (
          <div key={k}>
            <SectionLabel style={{ marginTop: 0 }}>{`A ${k} packet, hop by hop`}</SectionLabel>
            <MiniTable head={["hop", "src", "dst"]} rows={rows[k].map((r) => [<span key="h">{r.hop}{r.outer && <><br /><span className="muted" style={{ fontSize: 11.5 }}>{r.outer}</span></>}</span>, r.src, r.dst])} />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "first byte after connect()", value: ms(run.ttfbMs) },
          { label: "bytes the balancer sends", value: bytes(run.lbBytes) },
          { label: "as a share of the client's bytes", value: pct(share) },
          { label: "packets through the balancer", value: int(run.lbPackets) },
        ]} />
      </div>
      <Note>Model inputs: 10 ms one way from the client to the edge router, 1 ms per data-center link (longer than real, so that the diagram shows the hops), the reference TCP with a 1460-byte MSS.</Note>
    </Demo>
  );
}

// ============================================================================ 2. Changes and open connections

const CHG = {
  change: seg<LbChange>("Change", [["addBackend", "add backend"], ["crashBackend", "backend crashes"], ["drainBackend", "drain backend"], ["addLb", "add balancer"], ["removeLb", "remove balancer"], ["addBoth", "add both"]], "addBackend"),
  ecmp: seg<EcmpKind>("ECMP in the router", [["threshold", "hash-threshold"], ["resilient", "resilient"]], "threshold"),
  backends: range({ label: "Backends", min: 3, max: 20, step: 1, default: 10 }),
  lbs: range({ label: "Balancers behind ECMP", min: 2, max: 8, step: 1, default: 4 }),
};

const LOOKUP_LABEL: Record<Lookup, string> = { modulo: "hash mod N", maglev: "Maglev table", random: "random pick" };
const FATE_COLOR: Record<Fate, string> = { kept: "var(--c3)", broken: "var(--c4)", dead: "var(--faint)" };

export function NetInfraLbChangeDemo() {
  const P = useParams("net-infra-lbchange", CHG);
  const { change, ecmp, backends, lbs } = P.values;
  const [sel, setSel] = useState<{ lookup: Lookup; conntrack: boolean }>({ lookup: "maglev", conntrack: true });
  const flows = 2000;
  const matrix = useMemo(() => changeMatrix({ change, ecmp, backends, lbs, flows }), [change, ecmp, backends, lbs]);
  const cur = useMemo(() => changeRun({ change, ecmp, backends, lbs, flows, ...sel }), [change, ecmp, backends, lbs, sel]);
  const idx = matrix.findIndex((m) => m.lookup === sel.lookup && m.conntrack === sel.conntrack);
  const shown = cur.flows.slice(0, 400);
  return (
    <Demo title="What happens to 2,000 open connections"
      controls={<>
        <Param spec={CHG.change} value={change} onChange={(v) => P.set("change", v as LbChange)} />
        <Param spec={CHG.ecmp} value={ecmp} onChange={(v) => P.set("ecmp", v as EcmpKind)} />
        <Param spec={CHG.backends} value={backends} onChange={(v) => P.set("backends", v as number)} />
        <Param spec={CHG.lbs} value={lbs} onChange={(v) => P.set("lbs", v as number)} />
      </>}
    >
      <MiniTable
        head={["how the balancer picks", "broken", "on the dead backend"]}
        rows={matrix.map((m) => [`${LOOKUP_LABEL[m.lookup]}${m.conntrack ? " + tracking" : ""}`, pct(m.r.broken / flows), m.r.dead ? pct(m.r.dead / flows) : "–"])}
        highlight={idx}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
        {matrix.map((m, i) => (
          <Chip key={i} color={i === idx ? "var(--c1)" : "var(--muted)"} filled={i === idx} onClick={() => setSel({ lookup: m.lookup, conntrack: m.conntrack })}>
            {LOOKUP_LABEL[m.lookup]}{m.conntrack ? " + tracking" : ""}
          </Chip>
        ))}
      </div>
      <SectionLabel>{`${LOOKUP_LABEL[sel.lookup]}${sel.conntrack ? " with connection tracking" : ", stateless"}: the first 400 connections`}</SectionLabel>
      <svg viewBox="0 0 400 104" width="100%" style={{ display: "block", maxHeight: 140 }} role="img" aria-label="connection fates">
        {shown.map((f, i) => (
          <rect key={i} x={(i % 40) * 10 + 1} y={Math.floor(i / 40) * 10 + 2} width={8} height={8} rx={2} fill={FATE_COLOR[f.fate]} opacity={f.lbAfter !== f.lbBefore ? 1 : 0.75} stroke={f.lbAfter !== f.lbBefore ? "var(--fg)" : "none"} strokeWidth={0.8} />
        ))}
      </svg>
      <Legend items={[{ label: "same backend: survives", color: "var(--c3)" }, { label: "new backend: RST", color: "var(--c4)" }, { label: "on the crashed backend", color: "var(--faint)" }]} />
      <Note>An outlined square is a connection that ECMP moved to another balancer.</Note>
      <Banner tone={cur.broken === 0 ? "good" : cur.broken / flows > 0.2 ? "bad" : "warn"} label={LB_CHANGE_LABEL[change]}>
        {cur.broken} of {flows} connections break ({pct(cur.broken / flows)}). ECMP moved {cur.movedLb} connections ({pct(cur.movedLb / flows)}) to another balancer.
        {cur.dead ? ` ${cur.dead} were on the crashed backend: nothing can save them.` : ""}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 3. Policies and tail latency

const POL = {
  load: range({ label: "Load (share of total capacity)", min: 0.3, max: 0.95, step: 0.05, default: 0.8, format: (v) => pct(v, 0) }),
  slow: toggle({ label: "Server 0 is 3 times slower", default: false }),
  stale: seg<string>("Load information is", [["0", "exact"], ["10", "10 ms old"], ["50", "50 ms old"], ["200", "200 ms old"]], "0"),
};
const POL_COLOR: Record<Policy, string> = { random: "var(--c4)", rr: "var(--c2)", lc: "var(--c1)", p2c: "var(--c3)" };
const LOADS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];

export function NetInfraLbPolicyDemo() {
  const P = useParams("net-infra-lbpolicy", POL);
  const { load, slow, stale } = P.values;
  const staleMs = Number(stale);
  const key = `${slow}-${stale}`;
  const jobs = useMemo(() => POLICIES.flatMap((policy) => LOADS.map((l) => () => ({ policy, load: l, p99: policyRun({ policy, load: l, slow: slow ? 3 : 1, staleMs, requests: 30_000 }).p99 }))), [slow, staleMs]);
  const sweep = useChunked(`net-infra-pol-${key}`, jobs, { keep: true });
  const nowJobs = useMemo(() => POLICIES.map((policy) => () => ({ policy, r: policyRun({ policy, load, slow: slow ? 3 : 1, staleMs, requests: 40_000 }) })), [load, slow, staleMs]);
  const now = useChunked(`net-infra-pol-now-${key}-${load}`, nowJobs, { keep: true }).filter((x): x is NonNullable<typeof x> => !!x);
  const top = 1000;
  const clamp = (v: number) => Math.min(top, Math.max(10, v));
  return (
    <Demo title="Ten servers, four policies: the 99th percentile"
      controls={<>
        <Param spec={POL.load} value={load} onChange={(v) => P.set("load", v as number)} />
        <Param spec={POL.slow} value={slow} onChange={(v) => P.set("slow", v as boolean)} />
        <Param spec={POL.stale} value={stale} onChange={(v) => P.set("stale", v as string)} />
      </>}
    >
      <Plot x={[0.3, 0.95]} y={[10, top]} logY height={230} xLabel="load" yLabel="p99 response time (ms)" xFormat={(v) => pct(v, 0)} yFormat={(v) => String(v)} yTicks={[10, 30, 100, 300, 1000]}>
        <RuleX at={load} color="var(--fg)" />
        {POLICIES.map((p) => (
          <Line key={p} color={POL_COLOR[p]} points={sweep.filter((s): s is NonNullable<typeof s> => !!s && s.policy === p).map((s) => [s.load, clamp(s.p99)] as const)} />
        ))}
      </Plot>
      <Legend items={POLICIES.map((p) => ({ label: POLICY_LABEL[p], color: POL_COLOR[p] }))} />
      <MiniTable
        head={["policy", "p50 (ms)", "p99 (ms)", "p99.9 (ms)", ...(slow ? ["server 0 gets"] : [])]}
        rows={now.map(({ policy, r }) => [POLICY_LABEL[policy], sig(r.p50), r.p99 > 5000 ? "> 5,000" : sig(r.p99), r.p999 > 5000 ? "> 5,000" : sig(r.p999), ...(slow ? [pct(r.perServer[0]! / r.perServer.reduce((a, b) => a + b, 0))] : [])])}
      />
      <Banner tone="plain">
        Many-server limit at this load, in mean service times: random {fixed(supermarketMean(load, 1))}, two choices {fixed(supermarketMean(load, 2))}.
        {slow ? " Round robin and random still send server 0 a tenth of the work, more than it can do, so its queue grows without bound." : ""}
        {staleMs >= 50 ? " With old counts, least connections sends every request to the server that looked emptiest: a herd." : ""}
      </Banner>
      <Note>Model inputs: Poisson arrivals, exponential service with a 10 ms mean, FCFS queues. Lines above 1 s are cut at the top.</Note>
    </Demo>
  );
}

// ============================================================================ 4. A backend fails

const HL = {
  failure: seg<string>("The backend", [["refuse", "returns errors"], ["hang", "hangs"]], "refuse"),
  check: seg<string>("Active health checks", [["off", "off"], ["5x3", "every 5 s, 3 failures"], ["30x2", "every 30 s, 2 failures"]], "5x3"),
  outlier: toggle({ label: "Outlier detection: eject after 5 errors in a row, for 30 s", default: false }),
  retries: range({ label: "Retries on another backend", min: 0, max: 2, step: 1, default: 0 }),
};

export function NetInfraLbHealthDemo() {
  const P = useParams("net-infra-lbhealth", HL);
  const { failure, check, outlier, retries } = P.values;
  const r = useMemo(() => healthRun({
    failure: failure as "refuse" | "hang", retries,
    check: check === "off" ? null : check === "5x3" ? { intervalS: 5, unhealthy: 3 } : { intervalS: 30, unhealthy: 2 },
    outlier: outlier ? { consecutive: 5, ejectS: 30 } : null,
  }), [failure, check, outlier, retries]);
  const maxY = Math.max(10, ...r.series.map((s) => Math.max(s[1], s[2]))) * 1.1;
  return (
    <Demo title="1,000 requests per second, 10 backends, one fails at 5 s"
      controls={<>
        <Param spec={HL.failure} value={failure} onChange={(v) => P.set("failure", v as string)} />
        <Param spec={HL.check} value={check} onChange={(v) => P.set("check", v as string)} />
        <Param spec={HL.outlier} value={outlier} onChange={(v) => P.set("outlier", v as boolean)} />
        <Param spec={HL.retries} value={retries} onChange={(v) => P.set("retries", v as number)} />
      </>}
    >
      <Plot x={[0, 60]} y={[0, maxY]} height={200} xLabel="time (s)" yLabel="requests per 0.5 s">
        <Bars bins={r.series.map(([t, e]) => ({ x0: t, x1: t + BUCKET_S, y: e }))} color="var(--c4)" />
        <Line points={r.series.map(([t, , d]) => [t + BUCKET_S / 2, d] as const)} color="var(--c2)" width={1.5} />
        {Number.isFinite(r.removedAt) && <RuleX at={r.removedAt} color="var(--c3)" label="removed" />}
      </Plot>
      <Legend items={[{ label: "errors the client sees", color: "var(--c4)" }, { label: "requests sent to the failed backend", color: "var(--c2)" }]} />
      <Banner tone={r.clientErrors === 0 ? "good" : r.clientErrors < 50 ? "warn" : "bad"}>
        {Number.isFinite(r.removedAt) ? `The balancer stopped using the backend at ${fixed(r.removedAt, 1)} s (${r.removedBy === "outlier" ? "outlier detection" : "health checks"}).` : "Nothing removes the backend."}
        {" "}{int(r.clientErrors)} requests failed for the client.
        {r.rescued ? ` Retries saved ${int(r.rescued)} requests, each about ${ms(r.extraMs / r.rescued)} late.` : ""}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "requests in 60 s", value: int(r.total) },
          { label: "sent to the failed backend", value: int(r.sentToDead) },
          { label: "client errors", value: int(r.clientErrors) },
          { label: "retries sent", value: int(r.retriesSent) },
        ]} />
      </div>
      <Note>Model inputs: an error answer is known after 1 ms, a hung request after a 1 s timeout, a health check of a hung backend after 2 s. After 30 s an ejected backend comes back and must fail again.</Note>
    </Demo>
  );
}
