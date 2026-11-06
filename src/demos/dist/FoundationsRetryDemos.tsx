/** Demos for "Timeouts, retries and idempotency": a retry storm against a bounded queue, and idempotency keys. */
import { useMemo, useState } from "react";
import { Banner, Bars, Demo, Legend, Line, MiniTable, Param, Plot, Stats, fixed, int, range, select, toggle, useParams, GOOD, BAD } from "../../kit";
import { SpaceTime, fromTrace, type StMark } from "./SpaceTime";
import { POLICIES, POLICY_TEXT, retryPreset, retrySim, type Policy, type RetryScenario as Scenario } from "../../sims/dist/foundations/retry";
import { ATTEMPT_FATES, ATTEMPT_TEXT, IDEM, allFates, chargeRun, type AttemptFate } from "../../sims/dist/foundations/idempotency";

// ============================================================================ 1. Retry storm

const RS = {
  size: range({ label: "Requests in the burst", min: 0.3, max: 1, step: 0.05, default: 0.65, format: (v) => String(Math.round(v * 300)) }),
  timeout: range({ label: "Client timeout", min: 20, max: 150, step: 5, default: 40, format: (v) => `${v} ms` }),
  base: range({ label: "Backoff base", min: 2, max: 50, step: 1, default: 10, format: (v) => `${v} ms` }),
  scenario: select({ label: "Scenario", options: [{ value: "burst", label: "a burst of requests at t = 0" }, { value: "outage", label: "steady load, server down 300–500 ms" }], default: "burst" as Scenario, segmented: true }),
  policy: select({ label: "Retry policy", options: POLICIES.map((p) => ({ value: p, label: POLICY_TEXT[p] })), default: "none" as Policy, segmented: true }),
  budget: toggle({ label: "Retry budget (about 10% of successes)", default: false }),
};

const LOAD_SPEC = range({ label: "Load (share of server capacity)", min: 0.3, max: 1, step: 0.05, default: 0.65, format: (v) => `${Math.round(v * 100)}%` });

export function RetryStormDemo() {
  const P = useParams("dist-retry-storm", RS);
  const { size, timeout, base, scenario, policy, budget } = P.values;
  const cfg = retryPreset(scenario, size, timeout, base, budget);
  const all = useMemo(() => POLICIES.map((p) => retrySim({ ...cfg, policy: p })), [scenario, size, timeout, base, budget]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = all[POLICIES.indexOf(policy)]!;
  const bk = cfg.bucket!;
  const finish = (x: typeof r) => {
    let last = 0;
    x.good.forEach((g, i) => { if (g > 0) last = (i + 1) * bk; });
    return last;
  };
  const xEnd = scenario === "burst" ? Math.min(cfg.horizon!, Math.max(300, Math.ceil((Math.max(...all.map(finish)) + 100) / 100) * 100)) : cfg.horizon!;
  const nb = Math.ceil(xEnd / bk);
  const sent = r.sent.slice(0, nb).map((y, i) => ({ x0: i * bk, x1: (i + 1) * bk, y }));
  const good = r.good.slice(0, nb).map((y, i) => [i * bk + bk / 2, y] as [number, number]);
  const yMax = Math.max(10, ...all.flatMap((x) => x.sent.slice(1, nb))) * 1.05;
  const totalReq = r.requests;
  return (
    <Demo
      title="Retries against a server with a bounded queue"
      controls={<>
        <Param spec={scenario === "burst" ? RS.size : LOAD_SPEC} value={size} onChange={(v) => P.set("size", v as number)} />
        <Param spec={RS.timeout} value={timeout} onChange={(v) => P.set("timeout", v as number)} />
        <Param spec={RS.base} value={base} onChange={(v) => P.set("base", v as number)} />
        <Param spec={RS.budget} value={budget} onChange={(v) => P.set("budget", v as boolean)} />
        <Param spec={RS.scenario} value={scenario} onChange={(v) => P.set("scenario", v as Scenario)} />
        <Param spec={RS.policy} value={policy} onChange={(v) => P.set("policy", v as Policy)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        The server does 1 request per ms (model input) and queues at most {cfg.queueCap}. A full queue answers "busy" at once.
        {scenario === "burst" ? ` ${totalReq} requests start together, as after a cache flush.` : ` New requests keep coming at ${Math.round(size * 100)}% of capacity.`}
      </div>
      <Plot x={[0, xEnd]} y={[0, yMax]} height={210} xLabel="time (ms)" yLabel={`per ${bk} ms`}>
        <Bars bins={sent} color="var(--c2)" opacity={0.55} />
        <Line points={good} color="var(--c3)" />
      </Plot>
      <Legend items={[{ label: "attempts sent", color: "var(--c2)" }, { label: "requests that succeeded", color: "var(--c3)" }]} />
      <div style={{ marginTop: 8 }}>
        <MiniTable
          head={["policy", "attempts", "succeeded", "gave up", scenario === "burst" ? "last success" : "goodput at end"]}
          rows={all.map((x, i) => [
            POLICY_TEXT[POLICIES[i]!], `${int(x.attempts)} (${fixed(x.amplification, 1)}×)`, int(x.succeeded),
            <span style={{ color: x.gaveUp ? BAD : undefined }}>{int(x.gaveUp)}</span>,
            scenario === "burst" ? `${int(finish(x))} ms` : <span style={{ color: x.goodputEnd < 0.5 * x.goodputBefore ? BAD : GOOD }}>{`${fixed(x.goodputEnd * 1000, 0)} /s`}</span>,
          ])}
          highlight={POLICIES.indexOf(policy)}
        />
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "requests", value: int(totalReq) },
          { label: "rejected as busy", value: int(r.rejected) },
          { label: "server work wasted on abandoned attempts", value: `${int(r.wastedMs)} of ${int(r.workMs)} ms` },
          { label: `most attempts in one ${bk} ms bucket`, value: int(Math.max(...r.sent)) },
        ]} />
      </div>
      <Banner tone={r.gaveUp > 0.05 * totalReq || (scenario === "outage" && r.goodputEnd < 0.5 * r.goodputBefore) ? "bad" : "good"}>
        {scenario === "outage" && r.goodputEnd < 0.5 * r.goodputBefore
          ? `The server is busy all the time, but ${int(r.wastedMs)} ms of its work went to attempts that their clients had already abandoned. Goodput stays near zero long after the outage ended.`
          : r.gaveUp > 0.05 * totalReq
            ? `${int(r.gaveUp)} requests gave up after ${cfg.maxAttempts} attempts. The retries came in synchronized waves and found the queue full each time.`
            : `All but ${int(r.gaveUp)} requests succeeded, with ${fixed(r.amplification, 2)} attempts per request.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Idempotency keys

const ID = {
  key: toggle({ label: "Send an idempotency key", default: false }),
  ttl: toggle({ label: "Server forgets keys after 40 ms (model)", default: false }),
};

const ATTEMPTS = 3;

export function IdempotencyDemo() {
  const P = useParams("dist-retry-idem", ID);
  const { key, ttl } = P.values;
  const [fates, setFates] = useState<AttemptFate[]>(["reply-lost", "ok", "ok"]);
  const ttlMs = ttl ? 40 : Infinity;
  const r = useMemo(() => chargeRun(fates, key, ttlMs), [fates, key, ttlMs]);
  const search = useMemo(() => {
    const seqs = allFates(ATTEMPTS);
    const count = (k: boolean) => seqs.filter((s) => chargeRun(s, k, ttlMs).charges > 1).length;
    return { total: seqs.length, without: count(false), with: count(true) };
  }, [ttlMs]);
  const st = fromTrace(r.net, (m) => {
    const p = m.payload;
    if (p.k === "charge") return m.dupOf !== undefined ? undefined : `${p.attempt + 1}`;
    if (p.k === "result") return p.replay ? "saved" : undefined;
    return "busy";
  });
  const marks: StMark[] = r.net.trace.flatMap((e) => (e.kind === "note" ? [{ node: e.node, t: e.t, label: e.node === 1 ? "$10" : e.text, color: e.node === 1 ? "var(--c4)" : "var(--c3)" }] : []));
  for (let i = 1; i <= ATTEMPTS; i++) if (!r.done || (r.doneAt ?? 0) > i * IDEM.timeout) marks.push({ node: 0, t: i * IDEM.timeout, color: "var(--c2)", shape: "cross" });
  const lastT = Math.max(...r.net.trace.map((e) => e.t), ...marks.map((mk) => mk.t));
  const tEnd = Math.ceil((lastT + 12) / 10) * 10;
  return (
    <Demo
      title="Charge $10, with retries"
      actions={<button className="btn ghost" onClick={() => setFates(["reply-lost", "ok", "ok"])}>Reset</button>}
      controls={<>
        <Param spec={ID.key} value={key} onChange={(v) => P.set("key", v as boolean)} />
        <Param spec={ID.ttl} value={ttl} onChange={(v) => P.set("ttl", v as boolean)} />
      </>}
    >
      <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
        {Array.from({ length: ATTEMPTS }, (_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <b style={{ width: 62, fontSize: 12.5 }}>attempt {i + 1}</b>
            <div className="seg">
              {ATTEMPT_FATES.map((f) => <button key={f} className={fates[i] === f ? "on" : ""} onClick={() => setFates(fates.map((x, j) => (j === i ? f : x)))}>{ATTEMPT_TEXT[f]}</button>)}
            </div>
          </div>
        ))}
      </div>
      <SpaceTime nodes={["client", "payments"]} tEnd={tEnd} messages={st.messages} marks={marks} rowHeight={56} />
      <div className="muted" style={{ fontSize: 12 }}>Numbers are attempts. An orange cross on the client line is a timeout ({IDEM.timeout} ms). "$10" marks each time the server takes money.</div>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "requests that reached the server", value: r.arrived },
          { label: "times the card was charged", value: <span style={{ color: r.charges > 1 ? BAD : undefined }}>{r.charges}</span> },
          { label: "money taken", value: `$${r.charges * IDEM.amount}` },
          { label: "client result", value: r.done ? `paid, charge #${r.chargeId}` : "no answer: unknown" },
        ]} />
      </div>
      <Banner tone={r.charges > 1 ? "bad" : r.done ? "good" : "warn"}>
        {r.charges > 1
          ? `The customer paid $${r.charges * IDEM.amount} for one $${IDEM.amount} order. ${key ? "The key had expired, so the server took the retry for a new payment." : "Without a key, the server cannot tell a retry from a new payment."}`
          : r.done
            ? key && r.replays > 0 ? `The retry carried the same key. The server found it and sent back the saved result: no second charge.` : `One charge, and the client knows about it.`
            : `The client gave up without an answer. It does not know if the card was charged (${r.charges} charge${r.charges === 1 ? "" : "s"}).`}
      </Banner>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
        Exhaustive search over all {search.total} fate sequences for {ATTEMPTS} attempts{ttl ? ", with keys that expire" : ""}: double charges in {search.without} without a key, and in {search.with} with a key.
      </div>
    </Demo>
  );
}
