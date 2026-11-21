/**
 * Views of the out-of-order core (src/sims/arch/ooo), shared by the five ooo lessons:
 * - OooTimeline: one row per fetched instruction, one column per cycle: front end, waiting, executing, done, commit,
 *   squash. Squashed rows are dimmed and struck through.
 * - RobRing: the reorder buffer as a circular buffer with its head and tail.
 * - RenameTables: the rename table, the retirement map and the free list.
 * - IssueTable: the issue queue or reservation stations, with each source as a value or a tag.
 * - LsqTables: the store queue and the load queue, with addresses, data and forwarding.
 * - ProbeLines: which lines of a probe array are in the cache.
 * Wide views scroll inside their own box.
 */
import { type CSSProperties, type ReactNode } from "react";
import { Legend, MONO, mono, tint } from "../../kit";
import { REG_ABI } from "../../sims/arch/rv";
import type { Frame, Uop, UopState, UopView } from "../../sims/arch/ooo";

export const STATE_COLOR: Record<UopState, string> = {
  front: "var(--c1)", waiting: "var(--muted)", executing: "var(--c3)", done: "var(--c5)", committed: "var(--faint)", squashed: "var(--c4)",
};
export const STATE_LABEL: Record<UopState, string> = {
  front: "front end", waiting: "waiting", executing: "executing", done: "done", committed: "committed", squashed: "squashed",
};
export const tag = (p: number) => `p${p}`;
export const reg = (r: number) => REG_ABI[r] ?? `x${r}`;
const hex = (v: number) => `0x${(v >>> 0).toString(16)}`;

const scroller: CSSProperties = { overflowX: "auto", maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 6 };

// ---------------------------------------------------------------- timeline

const CW = 16, RH = 20;

/**
 * Rows are instructions in fetch order, columns are cycles. F: front end. A thin line: waiting in the issue queue.
 * X: executing (M: a load that missed). A light bar: done, waiting to commit. C: commit. ✕: squashed.
 */
export function OooTimeline({ uops, cursor, maxRows = 60, from = 0, label }: { uops: Uop[]; cursor?: number; maxRows?: number; from?: number; label?: (u: Uop) => ReactNode }) {
  const rows = uops.slice(from, from + maxRows);
  let c0 = Infinity, c1 = 0;
  for (const u of rows) {
    c0 = Math.min(c0, u.fetch);
    c1 = Math.max(c1, u.commit, u.squash, u.ready, u.fetch);
  }
  if (!rows.length) { c0 = 0; c1 = 0; }
  if (cursor !== undefined) c1 = Math.max(c1, Math.min(cursor, c1 + 4));
  const n = c1 - c0 + 1;
  const LW = 150;
  const x = (c: number) => (c - c0) * CW;
  const seg = (a: number, b: number, style: CSSProperties, text?: string, key?: string) =>
    b > a ? (
      <div key={key} style={{ position: "absolute", left: x(a) + 1, width: (b - a) * CW - 2, top: 3, height: RH - 6, borderRadius: 3, fontSize: 9.5, lineHeight: `${RH - 6}px`, textAlign: "center", overflow: "hidden", fontFamily: MONO, ...style }}>{text}</div>
    ) : null;
  const end = (u: Uop) => (u.squash >= 0 ? u.squash : u.commit >= 0 ? u.commit : c1 + 1);
  return (
    <div>
      <div style={scroller}>
        <div style={{ width: LW + n * CW, position: "relative", padding: "2px 0" }}>
          <div style={{ display: "flex", height: 16 }}>
            <div className="muted" style={{ position: "sticky", left: 0, zIndex: 2, width: LW, minWidth: LW, background: "var(--bg)", fontSize: 11, paddingLeft: 8, boxSizing: "border-box" }}>cycle</div>
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className="muted" style={{ width: CW, minWidth: CW, textAlign: "center", fontSize: 9, ...mono, fontWeight: c0 + i === cursor ? 700 : 400 }}>{(c0 + i) % 5 === 0 || c0 + i === cursor ? c0 + i : ""}</div>
            ))}
          </div>
          {cursor !== undefined && cursor >= c0 && cursor <= c1 && (
            <div style={{ position: "absolute", top: 2, bottom: 2, left: LW + x(cursor), width: CW, background: "var(--subtle)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)" }} />
          )}
          {rows.map((u) => {
            const lim = (c: number) => (cursor === undefined ? c : Math.min(c, cursor + 1));
            const sq = u.squash >= 0;
            const ren = u.rename >= 0 ? u.rename : end(u);
            const iss = u.issue >= 0 ? u.issue : end(u);
            const rdy = u.ready >= 0 ? Math.min(u.ready, end(u)) : end(u);
            return (
              <div key={u.id} style={{ display: "flex", height: RH, position: "relative", opacity: sq ? 0.5 : 1 }}>
                <div title={u.text} style={{ position: "sticky", left: 0, zIndex: 2, width: LW, minWidth: LW, background: "var(--bg)", fontFamily: MONO, fontSize: 11.5, lineHeight: `${RH}px`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingLeft: 8, paddingRight: 6, boxSizing: "border-box", textDecoration: sq ? "line-through" : undefined, color: u.wrong ? "var(--c4)" : "var(--fg)" }}>
                  {label ? label(u) : u.text}
                </div>
                <div style={{ position: "relative", width: n * CW }}>
                  {seg(u.fetch, lim(ren), { background: tint("var(--c1)", 28) }, ren - u.fetch >= 1 ? "F" : "", "f")}
                  {seg(ren, lim(iss), { height: 2, top: RH / 2 - 1, background: "var(--muted)" }, "", "w")}
                  {seg(iss, lim(rdy), { background: tint(u.missed ? "var(--c2)" : "var(--c3)", 45), boxShadow: `inset 0 -2px 0 ${u.missed ? "var(--c2)" : "var(--c3)"}` }, u.missed ? "M" : "X", "x")}
                  {u.ready >= 0 && seg(rdy, lim(end(u)), { background: tint("var(--c5)", 18) }, "", "d")}
                  {u.commit >= 0 && (cursor === undefined || u.commit <= cursor) && seg(u.commit, u.commit + 1, { background: "var(--c5)", color: "var(--bg)", fontWeight: 700 }, "C", "c")}
                  {sq && (cursor === undefined || u.squash <= cursor) && seg(u.squash, u.squash + 1, { color: "var(--c4)", fontWeight: 700, fontSize: 12 }, "✕", "s")}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Legend items={[
        { label: "F front end", color: "var(--c1)" }, { label: "waiting", color: "var(--muted)" }, { label: "X executing", color: "var(--c3)" },
        { label: "M load miss", color: "var(--c2)" }, { label: "done, waits to commit", color: "var(--c5)" }, { label: "✕ squashed (red text: wrong path)", color: "var(--c4)" },
      ]} />
    </div>
  );
}

/** An instruction written with physical register names, as the back end sees it after rename. */
export function physText(u: UopView): string {
  const op = u.text.split(/\s+/)[0] ?? "";
  const dst = u.rd ? `${tag(u.pd)} ← ` : "";
  const src = u.ps.map(tag).join(", ");
  return `${op} ${dst}${src}`.trim();
}

// ---------------------------------------------------------------- ROB as a ring

/** The ROB as `size` slots in a circle of cells. The head (oldest) commits next; new entries go in at the tail. */
export function RobRing({ frame, size, cols }: { frame: Frame; size: number; cols?: number }) {
  const bySlot = new Map(frame.rob.map((u) => [u.slot, u] as const));
  const head = frame.rob[0]?.slot ?? -1;
  const tail = frame.rob.length ? (frame.rob[frame.rob.length - 1]!.slot + 1) % size : -1;
  const small = size > 32;
  const grid = cols ? `repeat(${cols}, minmax(0, 1fr))` : `repeat(auto-fill, minmax(${small ? 22 : 74}px, 1fr))`;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: grid, gap: 3 }}>
        {Array.from({ length: size }, (_, i) => {
          const u = bySlot.get(i);
          const col = u ? STATE_COLOR[u.state] : "var(--border)";
          return (
            <div key={i} title={u ? `${u.text}: ${STATE_LABEL[u.state]}` : "free"} style={{
              position: "relative", height: small ? 22 : 38, borderRadius: 4, padding: small ? 0 : "2px 4px", boxSizing: "border-box",
              border: `1px solid ${i === head ? "var(--fg)" : "var(--border)"}`, background: u ? tint(col, u.wrong ? 14 : 30) : "transparent",
              boxShadow: u ? `inset 0 -3px 0 ${col}` : undefined, fontSize: 10, lineHeight: 1.25, overflow: "hidden", ...mono,
            }}>
              {!small && <div className="muted" style={{ fontSize: 9 }}>{i}{i === head ? " head" : i === tail && frame.rob.length < size ? " tail" : ""}</div>}
              {!small && u && <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: u.wrong ? "var(--c4)" : "var(--fg)", textDecoration: u.mispredict ? "underline wavy var(--c4)" : undefined }}>{u.text}</div>}
              {small && i === head && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700 }}>H</div>}
            </div>
          );
        })}
      </div>
      <Legend items={(["waiting", "executing", "done"] as UopState[]).map((s) => ({ label: STATE_LABEL[s], color: STATE_COLOR[s] })).concat([{ label: "red text: wrong path", color: "var(--c4)" }])} />
    </div>
  );
}

// ---------------------------------------------------------------- rename tables

/** The rename table (speculative map), the retirement map and the free list, for the registers in `regs`. */
export function RenameTables({ frame, regs, freeMax = 24, showFree = true }: { frame: Frame; regs: number[]; freeMax?: number; showFree?: boolean }) {
  const changed = new Set(frame.rob.filter((u) => frame.renamed.includes(u.id) && u.rd).map((u) => u.rd));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, ...mono }}>
          <tbody>
            <tr><td className="muted" style={{ paddingRight: 8 }}>register</td>{regs.map((r) => <td key={r} style={{ padding: "1px 6px", textAlign: "center" }}>{reg(r)}</td>)}</tr>
            <tr>
              <td className="muted" style={{ paddingRight: 8 }}>rename map</td>
              {regs.map((r) => {
                const p = frame.rat[r]!, ready = frame.prfReady[p];
                return <td key={r} style={{ padding: "1px 6px", textAlign: "center", background: changed.has(r) ? tint("var(--c2)", 35) : undefined, color: ready ? "var(--fg)" : "var(--c2)", fontWeight: frame.rat[r] !== frame.rrat[r] ? 700 : 400 }}>{tag(p)}</td>;
              })}
            </tr>
            <tr><td className="muted" style={{ paddingRight: 8 }}>committed map</td>{regs.map((r) => <td key={r} style={{ padding: "1px 6px", textAlign: "center", color: "var(--muted)" }}>{tag(frame.rrat[r]!)}</td>)}</tr>
          </tbody>
        </table>
      </div>
      {showFree && <div style={{ fontSize: 12 }}>
        <span className="muted">free list ({frame.free.length}): </span>
        <span style={{ ...mono, overflowWrap: "anywhere" }}>{frame.free.slice(0, freeMax).map(tag).join(" ")}{frame.free.length > freeMax ? " …" : ""}{frame.free.length === 0 ? "empty" : ""}</span>
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------- issue queue / reservation stations

const srcCell = (u: UopView, k: number, tomasulo: boolean): ReactNode => {
  if (k >= u.srcs.length) return <span className="muted">-</span>;
  if (u.srcReady[k]) return <span>{u.srcVal[k]}</span>;
  return <span style={{ color: "var(--c2)", fontWeight: 600 }}>{tomasulo ? `wait ${tag(u.ps[k]!)}` : `${tag(u.ps[k]!)}?`}</span>;
};
const UNIT_NAME = { alu: "ALU", mul: "mul", div: "div", mem: "load/store" } as const;

/** The instructions that wait to issue (and, with `all`, the ones executing), with each source as a value or a tag. */
export function IssueTable({ frame, tomasulo = false, units }: { frame: Frame; tomasulo?: boolean; units?: (keyof typeof UNIT_NAME)[] }) {
  const list = frame.rob.filter((u) => u.state === "waiting" || u.state === "executing" || frame.issued.includes(u.id));
  const order = units ?? ["alu", "mul", "div", "mem"];
  const rows = order.flatMap((un) => list.filter((u) => u.unit === un));
  const th: CSSProperties = { padding: "2px 6px", textAlign: "left", color: "var(--muted)", fontWeight: 600, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
  const td: CSSProperties = { padding: "2px 6px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%", ...mono }}>
        <thead><tr><th style={th}>unit</th><th style={th}>instruction</th><th style={th}>{tomasulo ? "tag" : "dest"}</th><th style={th}>{tomasulo ? "Vj / Qj" : "src 1"}</th><th style={th}>{tomasulo ? "Vk / Qk" : "src 2"}</th><th style={th}>state</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td style={td} colSpan={6} className="muted">empty</td></tr>}
          {rows.map((u) => (
            <tr key={u.id} style={{ background: frame.issued.includes(u.id) ? tint("var(--c3)", 22) : undefined, color: u.wrong ? "var(--c4)" : undefined }}>
              <td style={td}>{UNIT_NAME[u.unit]}</td>
              <td style={td}>{u.text}</td>
              <td style={td}>{u.rd ? tag(u.pd) : "-"}</td>
              <td style={td}>{srcCell(u, 0, tomasulo)}</td>
              <td style={td}>{srcCell(u, 1, tomasulo)}</td>
              <td style={{ ...td, color: u.state === "waiting" ? "var(--muted)" : STATE_COLOR[u.state], whiteSpace: "normal", minWidth: 120 }}>
                {frame.issued.includes(u.id) ? "issued now" : u.state === "waiting" ? u.why || "waiting" : u.state === "executing" ? `executing, result at ${u.ready}` : STATE_LABEL[u.state]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- load and store queues

/** The store queue and the load queue: address (or ? when unknown), data, and where each load got its value. */
export function LsqTables({ frame, base = 0, names }: { frame: Frame; base?: number; names?: (addr: number) => string }) {
  const where = (a: number) => (names ? names(a) : hex(a - base));
  const sq = frame.rob.filter((u) => u.cls === "store"), lq = frame.rob.filter((u) => u.cls === "load");
  const box: CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", minWidth: 0 };
  const line = (u: UopView, body: ReactNode) => (
    <div key={u.id} style={{ display: "flex", gap: 8, fontSize: 12, padding: "2px 0", borderTop: "1px solid var(--border)", ...mono, color: u.wrong ? "var(--c4)" : undefined, flexWrap: "wrap" }}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 120px" }}>{u.text}</span>{body}
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
      <div style={box}>
        <div className="muted" style={{ fontSize: 11.5 }}>Store queue (oldest first)</div>
        {sq.length === 0 && <div className="muted" style={{ fontSize: 12 }}>empty</div>}
        {sq.map((u) => line(u, <span>
          <span style={{ color: u.addrKnown ? "var(--fg)" : "var(--c2)" }}>{u.addrKnown ? where(u.addr) : "addr ?"}</span>{" "}
          <span style={{ color: u.dataReady ? "var(--fg)" : "var(--c2)" }}>{u.dataReady ? `data ${u.value}` : "data ?"}</span>
        </span>))}
      </div>
      <div style={box}>
        <div className="muted" style={{ fontSize: 11.5 }}>Load queue (oldest first)</div>
        {lq.length === 0 && <div className="muted" style={{ fontSize: 12 }}>empty</div>}
        {lq.map((u) => line(u, <span>
          {u.issue < 0 || u.issue > frame.cycle ? <span className="muted">{u.why || "not issued"}</span>
            : <span>{where(u.addr)} {u.fwdFrom >= 0 ? <b style={{ color: "var(--c3)" }}>forwarded {u.value}</b> : <span>{u.state === "executing" ? "reading" : `read ${u.value}`}</span>}</span>}
        </span>))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- probe lines

/** Lines 0..n-1 of a probe array: in the cache (filled) or not. `mark` outlines one line (for example the secret). */
export function ProbeLines({ present, n = 16, mark, hit, miss }: { present: number[]; n?: number; mark?: number; hit?: number; miss?: number }) {
  const set = new Set(present);
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${n / 2}, minmax(30px, 1fr))`, gap: 4 }}>
      {Array.from({ length: n }, (_, i) => {
        const on = set.has(i);
        return (
          <div key={i} style={{
            height: 40, borderRadius: 4, border: `1.5px ${i === mark ? "dashed var(--fg)" : "solid var(--border)"}`,
            background: on ? tint("var(--c3)", 55) : "transparent", display: "grid", placeItems: "center", fontSize: 11, lineHeight: 1.2, textAlign: "center", ...mono,
          }}>
            <div>{i}</div>
            {hit !== undefined && <div style={{ fontSize: 9.5, color: on ? "var(--fg)" : "var(--muted)" }}>{on ? hit : miss}</div>}
          </div>
        );
      })}
    </div>
  );
}
