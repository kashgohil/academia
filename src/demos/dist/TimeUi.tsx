/**
 * Views that the "Time and order" demos share: a space-time diagram whose events can be clicked, and the run
 * builder that the Lamport and vector clock lessons use.
 */
import type { ReactNode } from "react";
import { Btn, ButtonRow, Chip, SmallLabel, useWidth } from "../../kit";
import { SpaceTime, type StMark, type StMessage, SPACETIME_LAYOUT } from "./SpaceTime";
import { addLocal, addSend, deliver, evName, inFlight, type Run } from "../../sims/dist/time/events";

const ST = { left: SPACETIME_LAYOUT.left, right: SPACETIME_LAYOUT.right, top: SPACETIME_LAYOUT.top, row: SPACETIME_LAYOUT.rowHeight };

export const PROC_NAMES = ["P1", "P2", "P3", "P4"];

export interface ClickEvent { id: number; node: number; t: number }

/** SpaceTime with a transparent layer of click targets on the events, and rings on the selected ones. */
export function ClickSpaceTime({
  nodes, tEnd, messages, marks, events, selected, onPick, cursor, timeLabel, children,
}: {
  nodes: string[]; tEnd: number; messages: StMessage[]; marks: StMark[]; events: ClickEvent[]; selected: number[];
  onPick: (id: number) => void; cursor?: number; timeLabel?: string; children?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(240, width);
  const h = ST.top + nodes.length * ST.row + 22;
  const x = (t: number) => ST.left + (t / Math.max(1e-9, tEnd)) * (w - ST.left - ST.right);
  const y = (i: number) => ST.top + i * ST.row + ST.row / 2;
  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <SpaceTime nodes={nodes} tEnd={tEnd} messages={messages} marks={marks} cursor={cursor} timeLabel={timeLabel} />
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} aria-hidden="true">
        {events.map((e) => {
          const k = selected.indexOf(e.id);
          return (
            <g key={e.id} onClick={() => onPick(e.id)} style={{ cursor: "pointer" }}>
              {k >= 0 && <circle cx={x(e.t)} cy={y(e.node)} r={8} fill="none" stroke={k === 0 ? "var(--c2)" : "var(--c5)"} strokeWidth={2.5} />}
              <circle cx={x(e.t)} cy={y(e.node)} r={11} fill="transparent" />
            </g>
          );
        })}
      </svg>
      {children}
    </div>
  );
}

/** Turns a hand-built run into SpaceTime props. Event i is at x = i + 1. Messages in flight are dashed. */
export function runToSpaceTime(run: Run, label: (id: number) => string | undefined, color?: (id: number) => string | undefined) {
  const tEnd = Math.max(6, run.events.length + 1);
  const messages: StMessage[] = run.msgs.map((m) => {
    const s = run.events[m.send]!.t + 1;
    if (m.recv === undefined) return { from: m.from, to: m.to, sentAt: s, deliveredAt: tEnd - 0.4, dashed: true, color: "var(--faint)" };
    return { from: m.from, to: m.to, sentAt: s, deliveredAt: run.events[m.recv]!.t + 1 };
  });
  const marks: StMark[] = run.events.map((e) => ({ node: e.proc, t: e.t + 1, label: label(e.id), color: color?.(e.id) ?? (e.kind === "local" ? "var(--muted)" : "var(--c1)") }));
  const events: ClickEvent[] = run.events.map((e) => ({ id: e.id, node: e.proc, t: e.t + 1 }));
  return { tEnd, messages, marks, events };
}

export const MAX_EVENTS = 18;

/** The buttons that add events: a local event or a send on each process, and a delivery for each message in flight. */
export function BuilderButtons({ run, setRun }: { run: Run; setRun: (r: Run) => void }) {
  const full = run.events.length >= MAX_EVENTS;
  const flying = inFlight(run);
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
      {Array.from({ length: run.n }, (_, p) => (
        <ButtonRow key={p}>
          <span style={{ fontSize: 12.5, width: 22, color: "var(--muted)" }}>{PROC_NAMES[p]}</span>
          <Btn onClick={() => setRun(addLocal(run, p))} disabled={full}>local</Btn>
          {Array.from({ length: run.n }, (_, q) => q).filter((q) => q !== p).map((q) => (
            <Btn key={q} onClick={() => setRun(addSend(run, p, q))} disabled={full}>{`send → ${PROC_NAMES[q]}`}</Btn>
          ))}
        </ButtonRow>
      ))}
      <ButtonRow>
        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>In flight:</span>
        {flying.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>none</span>}
        {flying.map((m) => (
          <Btn key={m.id} onClick={() => setRun(deliver(run, m.id))} disabled={full}>{`deliver ${evName(m.send)}: ${PROC_NAMES[m.from]} → ${PROC_NAMES[m.to]}`}</Btn>
        ))}
      </ButtonRow>
      {full && <SmallLabel>The diagram is full. Undo or clear to go on.</SmallLabel>}
    </div>
  );
}

/** A row of event names with their stamps, for screens too narrow to label the diagram. */
export function StampChips({ run, text, selected, onPick }: { run: Run; text: (id: number) => string; selected: number[]; onPick: (id: number) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
      {run.events.map((e) => (
        <Chip key={e.id} onClick={() => onPick(e.id)} color={selected[0] === e.id ? "var(--c2)" : selected[1] === e.id ? "var(--c5)" : "var(--muted)"} bold={selected.includes(e.id)}>
          {`${evName(e.id)} ${text(e.id)}`}
        </Chip>
      ))}
    </div>
  );
}
