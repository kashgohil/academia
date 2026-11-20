/** Demos for "The actor model": selective receive on a long mailbox, and an OTP supervisor. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Demo, Legend, Line, MONO, Note, Panel, Param, Plot, RuleY, SectionLabel, Stats, int, range, seg, useChunked, useParams, type Tone,
} from "../../kit";
import {
  CHILD_NAMES, MAILBOX_DEFAULTS, replaySupervisor, runMailbox, tippingBacklog, type MailboxResult, type Strategy, type SupAction,
} from "../../sims/conc/message-passing";

// ---------------------------------------------------------------- selective receive

const MB = {
  burst: range({ label: "Backlog at the start", min: 0, max: 1500, step: 50, default: MAILBOX_DEFAULTS.burst, format: (v) => `${v} messages` }),
  rate: range({ label: "Arrivals", min: 6, max: 13, step: 1, default: MAILBOX_DEFAULTS.perMs, format: (v) => `${v} per ms` }),
  scan: range({ label: "Cost to skip one message (model input)", min: 25, max: 400, step: 25, default: MAILBOX_DEFAULTS.scanNs, format: (v) => `${v} ns` }),
};

export function ConcMsgMailboxDemo() {
  const P = useParams("conc-msg-mailbox", MB);
  const { burst, rate, scan } = P.values;
  const key = `${burst}/${rate}/${scan}`;
  const jobs = useMemo(() => [false, true].map((refOpt) => () => runMailbox({ refOpt, burst, perMs: rate, scanNs: scan })), [burst, rate, scan]);
  const [plain, opt] = useChunked<MailboxResult>(key, jobs, { keep: true });
  const tip = tippingBacklog({ ...MAILBOX_DEFAULTS, perMs: rate, scanNs: scan });
  const pts = (r?: MailboxResult) => (r ? r.samples.map(([t, n]) => [t / 1e6, n] as [number, number]) : []);
  const maxY = Math.max(burst, 200, ...(plain?.samples.map((s) => s[1]) ?? [0]), ...(opt?.samples.map((s) => s[1]) ?? [0]));
  const capacity = 1e6 / (MAILBOX_DEFAULTS.handleNs + MAILBOX_DEFAULTS.callNs);
  return (
    <Demo
      title="A server whose mailbox fills up"
      controls={<>{(Object.keys(MB) as (keyof typeof MB)[]).map((k) => <Param key={k} spec={MB[k]} value={P.values[k]} onChange={(v) => P.set(k, v as number)} />)}</>}
    >
      <Plot x={[0, MAILBOX_DEFAULTS.durationNs / 1e6]} y={[0, maxY * 1.08]} height={220} xLabel="time (ms)" yLabel="messages in the mailbox">
        {tip < maxY * 1.08 && <RuleY at={tip} label={`tipping point ≈ ${int(tip)}`} />}
        <Line points={pts(plain)} color="var(--c4)" />
        <Line points={pts(opt)} color="var(--c3)" />
      </Plot>
      <Legend items={[{ label: "receive matches a pattern: scans from the oldest message", color: "var(--c4)" }, { label: "receive matches a fresh reference: skips older messages", color: "var(--c3)" }]} />
      <Stats items={[
        { label: "handled in 300 ms (pattern / reference)", value: plain && opt ? `${int(plain.handled)} / ${int(opt.handled)}` : "…" },
        { label: "messages examined per call", value: plain && opt ? `${int(plain.scannedPerCall)} / ${int(opt.scannedPerCall)}` : "…" },
        { label: "mailbox at the end", value: plain && opt ? `${int(plain.finalLen)} / ${int(opt.finalLen)}` : "…" },
      ]} />
      <Note>
        Each request costs {int(MAILBOX_DEFAULTS.handleNs / 1_000)} µs of work plus a call to a database process that takes {int(MAILBOX_DEFAULTS.callNs / 1_000)} µs.
        With an empty mailbox the server handles about {int(capacity)} requests per ms. Requests arrive at random times.
      </Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- supervisor

const SUP = {
  strategy: seg<Strategy>("Strategy", [["one_for_one", "one_for_one"], ["one_for_all", "one_for_all"], ["rest_for_one", "rest_for_one"]], "one_for_one"),
  intensity: range({ label: "intensity (max restarts)", min: 1, max: 5, step: 1, default: 1 }),
  period: range({ label: "period", min: 1, max: 30, step: 1, default: 5, format: (v) => `${v} s` }),
};

const TONE: Record<string, Tone> = { plain: "plain", bad: "bad", good: "good", warn: "warn" };

export function ConcMsgSupervisorDemo() {
  const P = useParams("conc-msg-sup", SUP);
  const { strategy, intensity, period } = P.values;
  const [acts, setActs] = useState<SupAction[]>([]);
  const s = useMemo(() => replaySupervisor({ strategy, intensity, period }, acts), [strategy, intensity, period, acts]);
  const prev = useMemo(() => replaySupervisor({ strategy, intensity, period }, acts.slice(0, -1)), [strategy, intensity, period, acts]);
  const push = (a: SupAction) => setActs([...acts, a]);
  const recent = s.inPeriod(s.restarts);
  const lastLog = s.log.slice(-5);
  return (
    <Demo
      title="Let it crash: a supervisor"
      actions={<>
        <Btn ghost onClick={() => setActs(acts.slice(0, -1))} disabled={!acts.length}>Back</Btn>
        <Btn ghost onClick={() => setActs([])}>Reset</Btn>
      </>}
      controls={<>
        <Param spec={SUP.strategy} value={strategy} onChange={(v) => { P.set("strategy", v as never); setActs([]); }} />
        <Param spec={SUP.intensity} value={intensity} onChange={(v) => { P.set("intensity", v as number); setActs([]); }} />
        <Param spec={SUP.period} value={period} onChange={(v) => { P.set("period", v as number); setActs([]); }} />
      </>}
    >
      <ButtonRow>
        {CHILD_NAMES.map((n, i) => <Btn key={n} onClick={() => push({ k: "crash", i })} disabled={s.stopped}>{`crash ${n}`}</Btn>)}
        <Btn ghost onClick={() => push({ k: "tick", s: 1 })} disabled={s.stopped}>wait 1 s</Btn>
        <Btn ghost onClick={() => push({ k: "tick", s: 5 })} disabled={s.stopped}>wait 5 s</Btn>
      </ButtonRow>
      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        <Panel title={`app_sup (parent)  ·  restarts of the subtree in the last ${period} s: ${s.inPeriod(s.parentRestarts).length}`} accent={s.stopped ? "var(--c4)" : "var(--border)"}>
          <Panel title={`sup  ·  ${strategy}  ·  t = ${s.t} s`} accent={s.stopped ? "var(--c4)" : "var(--c1)"}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
              {s.children.map((c, i) => {
                const restarted = !s.stopped && prev.children[i] && prev.children[i]!.pid !== c.pid;
                return (
                  <Panel key={c.name} title={c.name} accent={s.stopped ? "var(--c4)" : restarted ? "var(--c2)" : "var(--c3)"}>
                    <div style={{ fontFamily: MONO, fontSize: 12 }}>{s.stopped ? "stopped" : `<0.${c.pid}.0>`}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>served {s.stopped ? "-" : c.served}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>starts {c.starts}</div>
                  </Panel>
                );
              })}
            </div>
          </Panel>
        </Panel>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>{`restarts that count now (t − time ≤ ${period} s):`}</span>
        {recent.length ? recent.map((t, i) => <Chip key={i} color="var(--c2)">{`t=${t}`}</Chip>) : <span className="muted" style={{ fontSize: 12 }}>none</span>}
        <span className="muted" style={{ fontSize: 12 }}>{`limit: more than ${intensity} stops the supervisor`}</span>
      </div>
      <SectionLabel>Log</SectionLabel>
      {lastLog.map((e, i) => (
        <Banner key={s.log.length - lastLog.length + i} tone={TONE[e.tone]} label={`t=${e.t}s`} style={{ marginTop: 4 }}>{e.text}</Banner>
      ))}
      <Stats items={[
        { label: "restarts by sup", value: s.log.filter((e) => e.tone === "good").length },
        { label: "subtree restarts by the parent", value: s.log.filter((e) => e.text.startsWith("The parent restarts")).length },
      ]} />
    </Demo>
  );
}
