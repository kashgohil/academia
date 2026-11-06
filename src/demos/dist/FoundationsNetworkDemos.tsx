/** Demos for "The network model": a playground on Net, and the two generals as a messenger chain. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, MiniTable, Param, Stats, StepCaption, pct, range, toggle, useParams, GOOD, BAD } from "../../kit";
import { SpaceTime, fromTrace, type StMark } from "./SpaceTime";
import { defaultSends, playgroundRun, type PgSend } from "../../sims/dist/foundations/playground";
import { GEN_LATENCY, generalsRun, knowledge, protocolTable, workingProtocols } from "../../sims/dist/foundations/generals";

// ============================================================================ 1. Playground

const PG = {
  min: range({ label: "Latency min", min: 1, max: 60, step: 1, default: 5, format: (v) => `${v} ms` }),
  max: range({ label: "Latency max", min: 1, max: 150, step: 1, default: 40, format: (v) => `${v} ms` }),
  drop: range({ label: "Loss", min: 0, max: 0.5, step: 0.01, default: 0.1, format: (v) => pct(v, 0) }),
  dup: range({ label: "Duplication", min: 0, max: 0.5, step: 0.01, default: 0, format: (v) => pct(v, 0) }),
  fifo: toggle({ label: "FIFO links (like TCP)", default: false }),
  cut: toggle({ label: "Cut node C off from 30 to 110 ms", default: false }),
};

const NODES = ["A", "B", "C"];
const CUT = { cut: 2, from: 30, to: 110 };

export function NetworkPlaygroundDemo() {
  const P = useParams("dist-net-pg", PG);
  const { min, drop, dup, fifo, cut } = P.values;
  const max = Math.max(min, P.values.max);
  const [sends, setSends] = useState<PgSend[]>(() => defaultSends());
  const [seed, setSeed] = useState(1);
  const { net, stats } = useMemo(
    () => playgroundRun(3, sends, { seed, latency: { min, max }, dropRate: drop, dupRate: dup, fifo, partition: cut ? CUT : undefined }),
    [sends, seed, min, max, drop, dup, fifo, cut],
  );
  const st = fromTrace(net, (m) => `${m.payload.seq}${m.dupOf !== undefined ? "′" : ""}`);
  const lastT = Math.max(0, ...net.messages.map((m) => m.deliveredAt ?? m.lostAt ?? m.sentAt));
  const tEnd = Math.max(120, Math.ceil((lastT + 5) / 20) * 20);
  const marks: StMark[] = cut ? [{ node: CUT.cut, t: CUT.from, until: CUT.to, shape: "bar", label: "cut off", color: "var(--c4)" }] : [];
  const nextT = sends.length ? sends[sends.length - 1]!.t + 8 : 0;
  const add = (from: number, to: number) => setSends([...sends, { t: nextT, from, to }]);
  return (
    <Demo
      title="A network you control"
      actions={<>
        <Btn onClick={() => setSeed(seed + 1)}>New random run</Btn>
        <Btn ghost onClick={() => { setSends(defaultSends()); setSeed(1); }}>Reset</Btn>
      </>}
      controls={<>
        <Param spec={PG.min} value={min} onChange={(v) => P.set("min", v as number)} />
        <Param spec={PG.max} value={P.values.max} onChange={(v) => P.set("max", v as number)} />
        <Param spec={PG.drop} value={drop} onChange={(v) => P.set("drop", v as number)} />
        <Param spec={PG.dup} value={dup} onChange={(v) => P.set("dup", v as number)} />
        <Param spec={PG.fifo} value={fifo} onChange={(v) => P.set("fifo", v as boolean)} />
        <Param spec={PG.cut} value={cut} onChange={(v) => P.set("cut", v as boolean)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Send one more:</span>
        <Btn onClick={() => add(0, 1)}>A → B</Btn>
        <Btn onClick={() => add(0, 2)}>A → C</Btn>
        <Btn onClick={() => add(1, 2)}>B → C</Btn>
        <Btn onClick={() => add(2, 0)}>C → A</Btn>
      </ButtonRow>
      <SpaceTime nodes={NODES} tEnd={tEnd} messages={st.messages} marks={marks} />
      <div className="muted" style={{ fontSize: 12 }}>The label is the send order on that link. A prime (′) marks a duplicate copy. A cross that stops short is a loss in the network; a cross on a line is a message that reached a cut-off node.</div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "sent", value: stats.sent },
          { label: "delivered", value: stats.delivered },
          { label: "lost in the network", value: stats.dropped },
          { label: "lost at the cut", value: stats.cut },
          { label: "duplicates", value: stats.duplicates },
          { label: "arrived out of order", value: stats.reordered },
          { label: "longest delay", value: `${Math.round(stats.maxDelay)} ms` },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. Two generals

const GEN = {
  k: range({ label: "Messengers in the protocol", min: 1, max: 6, step: 1, default: 3 }),
  tA: range({ label: "A attacks after it receives at least", min: 0, max: 4, step: 1, default: 1, format: (v) => `${v} messenger${v === 1 ? "" : "s"}` }),
  tB: range({ label: "B attacks after it receives at least", min: 0, max: 4, step: 1, default: 1, format: (v) => `${v} messenger${v === 1 ? "" : "s"}` }),
};

export function TwoGeneralsDemo() {
  const P = useParams("dist-net-gen", GEN);
  const { k, tA, tB } = P.values;
  const [lost, setLost] = useState(0);
  const cap = Math.min(lost, k);
  const run = useMemo(() => generalsRun(k, cap), [k, cap]);
  const rows = protocolTable(k, tA, tB);
  const bad = rows.filter((r) => !r.ok).length;
  const st = fromTrace(run.net, (m) => `m${m.payload.i}`);
  const row = rows.find((r) => r.lost === cap)!;
  const works = workingProtocols(k).length;
  return (
    <Demo
      title="The two generals"
      controls={<>
        <Param spec={GEN.k} value={k} onChange={(v) => { P.set("k", v as number); setLost(0); }} />
        <Param spec={GEN.tA} value={tA} onChange={(v) => P.set("tA", v as number)} />
        <Param spec={GEN.tB} value={tB} onChange={(v) => P.set("tB", v as number)} />
      </>}
    >
      <div className="param" style={{ marginBottom: 8 }}>
        <span className="param-label"><span>You are the enemy. Capture messenger:</span></span>
        <div className="seg">
          <button className={cap === 0 ? "on" : ""} onClick={() => setLost(0)}>none</button>
          {Array.from({ length: k }, (_, i) => <button key={i} className={cap === i + 1 ? "on" : ""} onClick={() => setLost(i + 1)}>m{i + 1}</button>)}
        </div>
      </div>
      <SpaceTime nodes={["A", "B"]} tEnd={(k + 1) * GEN_LATENCY} messages={st.messages} rowHeight={52}
        marks={[
          { node: 0, t: (k + 1) * GEN_LATENCY - 2, label: row.attackA ? "attacks" : "waits", color: row.attackA ? "var(--c4)" : "var(--muted)" },
          { node: 1, t: (k + 1) * GEN_LATENCY - 2, label: row.attackB ? "attacks" : "waits", color: row.attackB ? "var(--c4)" : "var(--muted)" },
        ]} />
      <StepCaption tone={row.ok ? "good" : "bad"} label={`${run.delivered} of ${k} arrived`}>
        {knowledge(run.delivered)} {row.ok ? "" : row.attackA !== row.attackB ? `Only ${row.attackA ? "A" : "B"} attacks, and it loses.` : row.delivered === k ? "Every messenger arrived, but nobody attacks: the protocol is useless." : "Both attack, but B never learned the plan."}
      </StepCaption>
      <div style={{ marginTop: 10 }}>
        <MiniTable
          head={["captured", "A got", "B got", "A", "B", "result"]}
          rows={rows.map((r) => [
            r.lost === 0 ? "none" : `m${r.lost}`, r.a, r.b,
            r.attackA ? "attack" : "wait", r.attackB ? "attack" : "wait",
            <span style={{ color: r.ok ? GOOD : BAD }}>{r.ok ? "ok" : r.attackA !== r.attackB ? "one alone" : r.lost === 0 ? "no attack" : "B blind"}</span>,
          ])}
          highlight={(i) => rows[i]!.lost === cap}
        />
      </div>
      <Banner tone={bad ? "bad" : "good"}>
        These rules fail in {bad} of {rows.length} runs. Of all {(k + 2) * (k + 2)} threshold pairs for {k} messenger{k > 1 ? "s" : ""}, {works} pass every run.
      </Banner>
    </Demo>
  );
}
