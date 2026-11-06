/** Demos for the lesson on session guarantees: a mobile client that switches servers, and read-your-writes tokens. */
import { useMemo, useState } from "react";
import { BAD, Banner, Btn, Chip, Demo, GOOD, MONO, Param, SmallLabel, Stats, fixed, range, seg, toggle, useParams, useWidth } from "../../kit";
import { DEFAULT_SESSION, GUARANTEES, GUARANTEE_NAMES, runSession, runTokens, tokenStats, type Guarantee, type SessionStep, type TokenMode } from "../../sims/dist/consistency";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";

const SESSION_SCHEMA = {
  interval: range({ label: "Anti-entropy period", min: 10, max: 200, step: 5, default: 80, format: (v) => `${v} ms` }),
  ryw: toggle({ label: "Read your writes", default: false }),
  mr: toggle({ label: "Monotonic reads", default: false }),
  wfr: toggle({ label: "Writes follow reads", default: false }),
  mw: toggle({ label: "Monotonic writes", default: false }),
  seed: range({ label: "Run", min: 1, max: 30, step: 1, default: 7 }),
};

export function MobileSessionDemo() {
  const P = useParams("cons-session", SESSION_SCHEMA);
  const [wref, wpx] = useWidth<HTMLDivElement>();
  const wide = wpx >= 560; // message labels only where they fit
  const { interval, seed } = P.values;
  const on = { ryw: P.values.ryw, mr: P.values.mr, wfr: P.values.wfr, mw: P.values.mw };
  const [servers, setServers] = useState(DEFAULT_SESSION.steps.map((s) => s.server));
  const steps: SessionStep[] = DEFAULT_SESSION.steps.map((s, i) => ({ ...s, server: servers[i]! }));
  const run = useMemo(() => runSession({ seed, interval, steps, on }), [seed, interval, servers.join(), on.ryw, on.mr, on.wfr, on.mw]); // eslint-disable-line react-hooks/exhaustive-deps
  const S = run.cfg.servers;
  const last = Math.max(...run.steps.map((s) => (Number.isFinite(s.end) ? s.end : 0)));
  const tEnd = Math.ceil((last + 15) / 20) * 20;
  const messages: StMessage[] = run.net.messages.filter((m) => m.sentAt <= tEnd).map((m) => {
    const p = m.payload;
    const label = p.k === "req" ? (p.f === "w" ? `w ${p.label}` : "read") : p.k === "resp" ? (p.wrote ? "ok" : p.log.join(" ") || "∅") : undefined;
    return { from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, label: wide ? label : undefined, color: p.k === "ae" ? "var(--faint)" : p.k === "req" ? "var(--c1)" : "var(--fg)" };
  });
  const marks: StMark[] = run.cfg.others.map(([s, t], i) => ({ node: s, t, label: wide ? `B${i + 1} (Bob)` : undefined, color: "var(--c2)" }));
  for (const st of run.steps) if (Number.isFinite(st.served) && st.served - st.arrived > 0.5) marks.push({ node: st.server, t: st.arrived, until: st.served, shape: "bar", label: wide ? "waits" : undefined, color: "var(--c5)" });
  const byKind = (g: Guarantee) => run.anomalies.filter((a) => a.kind === g);
  const unfinished = run.steps.filter((s) => !Number.isFinite(s.end)).length;
  return (
    <Demo title="Alice's phone switches servers" controls={<>{(["interval", "ryw", "mr", "wfr", "mw", "seed"] as const).map((k) => <Param key={k} spec={SESSION_SCHEMA[k]} value={P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}>
      <SmallLabel>Bob posts B1 at S3. Alice runs five steps; tap a server to send that step elsewhere. Faint arrows are anti-entropy.</SmallLabel>
      <div ref={wref}><SpaceTime nodes={[...Array.from({ length: S }, (_, i) => `S${i + 1}`), "Alice"]} tEnd={tEnd} messages={messages} marks={marks} rowHeight={42} /></div>
      <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
        {run.steps.map((st, i) => (
          <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12.5 }}>
            <span className="muted" style={{ width: 16 }}>{i + 1}</span>
            <span style={{ width: 72, fontFamily: MONO }}>{st.f === "w" ? `write ${st.label}` : "read"}</span>
            <Btn onClick={() => setServers((s) => s.map((x, j) => (j === i ? (x + 1) % S : x)))}>{`at S${st.server + 1}`}</Btn>
            {st.f === "r" && st.saw && (
              <span style={{ display: "inline-flex", gap: 3, flexWrap: "wrap" }}>
                {st.saw.length === 0 && <span className="muted">sees nothing</span>}
                {st.saw.map((l) => <Chip key={l} color={l.startsWith("A") ? "var(--c1)" : "var(--c2)"}>{l}</Chip>)}
                {[...(st.missingOwn ?? []), ...(st.missingSeen ?? [])].map((l) => <Chip key={`m${l}`} color={BAD} dashed strike>{l}</Chip>)}
              </span>
            )}
            {!Number.isFinite(st.end) && <span style={{ color: BAD }}>still waiting</span>}
            {Number.isFinite(st.served) && st.served - st.arrived > 0.5 && <span className="muted">waited {fixed(st.served - st.arrived, 0)} ms</span>}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 6, marginTop: 10 }}>
        {GUARANTEES.map((g) => {
          const a = byKind(g);
          return (
            <div key={g} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "5px 8px", boxShadow: `inset 3px 0 0 ${a.length ? BAD : GOOD}`, fontSize: 12.5 }}>
              <div style={{ fontWeight: 600 }}>{GUARANTEE_NAMES[g]} <span className="muted" style={{ fontWeight: 400 }}>{on[g] ? "(on)" : "(off)"}</span></div>
              <div style={{ color: a.length ? BAD : "var(--muted)" }}>{a.length ? a[0]!.text : "no violation"}</div>
            </div>
          );
        })}
      </div>
      <Stats items={[
        { label: "violations", value: run.anomalies.length },
        { label: "time spent waiting", value: `${fixed(run.waited, 0)} ms` },
        { label: "steps not done", value: unfinished },
      ]} />
    </Demo>
  );
}

// ============================================================================ tokens

const TOKEN_SCHEMA = {
  mode: seg<TokenMode>("Read with a token", [["none", "no token"], ["wait", "replica waits"], ["redirect", "go to primary"]], "none"),
  replay: range({ label: "Mean replay delay (model input)", min: 2, max: 80, step: 1, default: 25, format: (v) => `${v} ms` }),
  seed: range({ label: "Run", min: 1, max: 30, step: 1, default: 3 }),
};

export function TokenDemo() {
  const P = useParams("cons-token", TOKEN_SCHEMA);
  const [wref, wpx] = useWidth<HTMLDivElement>();
  const wide = wpx >= 560;
  const { mode, replay, seed } = P.values;
  const run = useMemo(() => runTokens({ mode, replay, seed, rounds: 4 }), [mode, replay, seed]);
  const st = tokenStats(run);
  const lastRead = Math.max(...run.reads.map((r) => r.end));
  const tEnd = Math.ceil((lastRead + 5) / 20) * 20;
  const C = run.cfg.replicas + 1;
  const staleRounds = new Set(run.reads.filter((r) => r.stale).map((r) => r.round));
  const messages: StMessage[] = run.net.messages.filter((m) => m.sentAt <= tEnd).map((m) => {
    const p = m.payload;
    const label = p.k === "write" ? undefined : p.k === "lsn" ? `lsn ${p.lsn}` : p.k === "read" ? `read ≥${p.token}` : p.k === "val" ? `v${p.lsn}` : p.k === "behind" ? "behind" : undefined;
    const bad = p.k === "val" && staleRounds.has(p.round) && m.to === C;
    return { from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, label: wide ? label : undefined, color: p.k === "wal" ? "var(--faint)" : bad ? BAD : p.k === "behind" ? "var(--c2)" : m.from === C ? "var(--c1)" : "var(--fg)" };
  });
  const marks: StMark[] = run.net.trace.flatMap((e) => (e.kind === "timer" && e.tag.startsWith("apply") && e.t <= tEnd ? [{ node: e.node, t: e.t, label: wide ? e.tag.slice(5) : undefined, color: "var(--c3)" }] : []));
  return (
    <Demo title="Read your writes with an LSN token" controls={<>{(["mode", "replay", "seed"] as const).map((k) => <Param key={k} spec={TOKEN_SCHEMA[k]} value={P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}>
      <SmallLabel>The client writes, keeps the LSN, and reads from a random replica. A green dot is a replica applying that LSN.</SmallLabel>
      <div ref={wref}><SpaceTime nodes={run.nodes} tEnd={tEnd} messages={messages} marks={marks} rowHeight={44} /></div>
      <Banner tone={st.stale ? "bad" : "good"}>
        {st.stale
          ? `${st.stale} of ${st.reads} reads missed the client's own write: the replica had not applied it yet.`
          : mode === "wait" ? `No stale reads. Replicas held reads until they had applied the token; the slowest read took ${fixed(st.maxLatency, 0)} ms.`
          : mode === "redirect" ? `No stale reads. ${st.redirected} of ${st.reads} reads found the replica behind and went to the primary.`
          : "No stale reads in this run, by luck: each replica happened to be ahead. Try another run."}
      </Banner>
      <Stats items={[
        { label: "stale reads", value: `${st.stale} of ${st.reads}` },
        { label: "mean read time", value: `${fixed(st.meanLatency, 1)} ms` },
        { label: "slowest read", value: `${fixed(st.maxLatency, 1)} ms` },
        { label: "reads at the primary", value: st.redirected },
      ]} />
    </Demo>
  );
}

