/**
 * Views for the transport module's TCP demos:
 * - tcpSpaceTime: SpaceTime props for a TCP run, with segment labels and colors.
 * - StateStrip: the RFC 9293 state of each endpoint over time, aligned under a SpaceTime diagram.
 * - SegmentLog: every segment of a run as a row; click one to see its header.
 */
import { useWidth, mono, tint, SmallLabel } from "../../kit";
import { SPACETIME_LAYOUT, type StMark, type StMessage } from "../dist/SpaceTime";
import { fromPackets, HeaderDiagram } from "./PacketViews";
import type { Packet, PacketNet } from "../../sims/net";
import { ACK, FIN, RST, SYN, flagText, segLabel, tcpHeaderFields, type TcpSegment, type TcpState } from "../../sims/net/transport";

/** A color per kind of segment: handshake, teardown, reset, retransmission, probe or window update, data, pure ACK. */
export function segColor(s: TcpSegment): string {
  if (s.flags & RST) return "var(--c4)";
  if (s.info.retx > 0 || s.info.why === "fast" || s.info.why === "sack" || s.info.why === "rto") return "var(--c4)";
  if (s.flags & SYN) return "var(--c2)";
  if (s.flags & FIN) return "var(--c5)";
  if (s.info.why === "probe" || s.info.why === "update") return "var(--c3)";
  if (s.len > 0) return "var(--c1)";
  return "var(--muted)";
}

/** Is this a segment worth a label in a busy diagram: handshake, FIN, RST, retransmission, probe or update. */
export const isControl = (s: TcpSegment) => !!(s.flags & (SYN | FIN | RST)) || s.info.retx > 0 || s.info.why === "probe" || s.info.why === "update";

/**
 * SpaceTime props for a TCP run. All labels sit at the same height between two rows, so a busy run labels only
 * control segments and the `selected` packet (`labels: "control"`).
 */
export function tcpSpaceTime(net: PacketNet<TcpSegment>, opts: { nodes?: number[]; filter?: (p: Packet<TcpSegment>) => boolean; label?: (p: Packet<TcpSegment>) => string | undefined; labels?: "all" | "control"; selected?: number } = {}): { names: string[]; messages: StMessage[]; marks: StMark[] } {
  const full = (p: Packet<TcpSegment>) => segLabel(p.payload) + (p.payload.info.retx ? " ↻" : "");
  return fromPackets(net, {
    nodes: opts.nodes,
    filter: opts.filter,
    label: opts.label ?? ((p) => (opts.labels !== "control" || isControl(p.payload) || p.id === opts.selected ? full(p) : undefined)),
    color: (p) => segColor(p.payload),
  });
}

const STATE_SHORT: Record<TcpState, string> = {
  CLOSED: "CLOSED", LISTEN: "LISTEN", SYN_SENT: "SYN_SENT", SYN_RECEIVED: "SYN_RCVD", ESTABLISHED: "ESTABLISHED",
  FIN_WAIT_1: "FIN_WAIT_1", FIN_WAIT_2: "FIN_WAIT_2", CLOSE_WAIT: "CLOSE_WAIT", CLOSING: "CLOSING", LAST_ACK: "LAST_ACK", TIME_WAIT: "TIME_WAIT",
};

export function stateColor(s: TcpState): string {
  if (s === "SYN_SENT" || s === "SYN_RECEIVED" || s === "LISTEN") return "var(--c2)";
  if (s === "ESTABLISHED") return "var(--c3)";
  if (s === "TIME_WAIT") return "var(--c4)";
  if (s === "CLOSED") return "var(--faint)";
  return "var(--c5)";
}

/** One row per endpoint: colored spans for its states. The x axis matches SpaceTime with the same tStart and tEnd. */
export function StateStrip({ rows, tStart = 0, tEnd }: { rows: { name: string; states: [number, TcpState][] }[]; tStart?: number; tEnd: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { left, right } = SPACETIME_LAYOUT;
  const w = Math.max(240, width);
  const rh = 22;
  const x = (t: number) => left + ((Math.min(Math.max(t, tStart), tEnd) - tStart) / Math.max(1e-9, tEnd - tStart)) * (w - left - right);
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${rows.length * rh + 2}`} width="100%" height={rows.length * rh + 2} role="img" aria-label="TCP states over time" style={{ display: "block" }}>
        {rows.map((r, i) => {
          const y = i * rh + 1;
          return (
            <g key={i}>
              <text x={left - 6} y={y + 14} textAnchor="end" fontSize="9.5" fill="var(--muted)">{r.name}</text>
              {r.states.map(([t, s], k) => {
                const t2 = r.states[k + 1]?.[0] ?? tEnd;
                if (t2 < tStart || t > tEnd || s === "CLOSED") return null;
                const x1 = x(t), x2 = x(t2);
                const label = STATE_SHORT[s];
                const fits = label.length * 6.1 + 6 <= x2 - x1;
                const c = stateColor(s);
                return (
                  <g key={k}>
                    <title>{`${s} from ${t.toFixed(1)} ms`}</title>
                    <rect x={x1} y={y + 1} width={Math.max(1.5, x2 - x1)} height={rh - 4} rx={3} fill={tint(c, 30)} stroke={c} strokeWidth={1} />
                    {fits && <text x={x1 + 4} y={y + 14} fontSize="10" fill="var(--fg)" style={mono}>{label}</text>}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const WHY: Record<string, string> = {
  syn: "open", synack: "open", data: "data", ack: "ACK", dupack: "duplicate ACK", delack: "delayed ACK", fin: "close",
  rst: "reset", rto: "retransmit after RTO", fast: "fast retransmit", sack: "retransmit (SACK)", probe: "zero-window probe",
  update: "window update", cookie: "SYN cookie",
};

/** The segments of a run, one per row. Click a row to see its header. Lost segments are struck through. */
export function SegmentLog({ net, filter, selected, onSelect, maxHeight = 190 }: { net: PacketNet<TcpSegment>; filter?: (p: Packet<TcpSegment>) => boolean; selected?: number; onSelect: (id: number | undefined) => void; maxHeight?: number }) {
  const lost = new Set(net.hops.filter((h) => h.lost).map((h) => h.pkt));
  const sends = net.trace.flatMap((e) => (e.kind === "send" && (!filter || filter(e.pkt)) ? [e] : []));
  const sel = sends.find((e) => e.pkt.id === selected)?.pkt;
  const cell = { padding: "2px 6px", whiteSpace: "nowrap" as const };
  return (
    <div>
      <div style={{ maxHeight, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, ...mono }}>
          <thead style={{ position: "sticky", top: 0, background: "var(--bg)" }}>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              {["ms", "from", "flags", "seq", "ack", "win", "len", "why"].map((h) => <th key={h} style={{ ...cell, fontWeight: 600, borderBottom: "1px solid var(--border)" }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {sends.map((e) => {
              const s = e.pkt.payload;
              const on = e.pkt.id === selected;
              return (
                <tr key={e.pkt.id} onClick={() => onSelect(on ? undefined : e.pkt.id)} style={{ cursor: "pointer", background: on ? tint("var(--c1)", 22) : undefined, color: segColor(s), textDecoration: lost.has(e.pkt.id) ? "line-through" : undefined }}>
                  <td style={cell}>{e.t.toFixed(1)}</td>
                  <td style={cell}>{net.names[e.node]}</td>
                  <td style={cell}>{flagText(s.flags)}</td>
                  <td style={cell}>{s.info.rseq}</td>
                  <td style={cell}>{s.flags & ACK ? s.info.rack : "–"}</td>
                  <td style={cell}>{s.wnd}</td>
                  <td style={cell}>{s.len}</td>
                  <td style={{ ...cell, color: "var(--muted)" }}>{(WHY[s.info.why] ?? s.info.why) + (lost.has(e.pkt.id) ? ", lost" : "")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sel ? (
        <div style={{ marginTop: 8 }}>
          <SmallLabel>
            Header of the selected segment (wire values). Options: {Object.entries(sel.payload.opts).map(([k, v]) => `${k} ${Array.isArray(v) ? v.map(([l, r]) => `${l}–${r}`).join(" ") : v}`).join(", ") || "none"}.
          </SmallLabel>
          <HeaderDiagram fields={tcpHeaderFields(sel.payload)} />
        </div>
      ) : (
        <SmallLabel style={{ marginTop: 6 }}>Click a row to see the header of that segment. Seq and ack are relative, as Wireshark shows them.</SmallLabel>
      )}
    </div>
  );
}
