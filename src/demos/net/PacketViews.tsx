/**
 * Shared views for the networking track.
 *
 * - fromPackets: turns a PacketNet run into SpaceTime props (src/demos/dist/SpaceTime.tsx), one arrow per hop.
 *   The arrow leaves when the first bit goes on the wire and lands when the last bit arrives, so a slow link draws
 *   a long arrow. A packet lost on the wire stops short; a packet dropped at a full queue is a cross at the sender.
 * - HeaderDiagram: a protocol header drawn as rows of bits, as RFCs draw them. Click a field to select it.
 */
import { useWidth } from "../../kit";
import type { StMark, StMessage } from "../dist/SpaceTime";
import type { Field, Packet, PacketNet } from "../../sims/net";
import { fieldOffsets } from "../../sims/net";

export function fromPackets<P>(
  net: PacketNet<P>,
  opts: {
    /** Which nodes are drawn, top to bottom. Default: all, in id order. */
    nodes?: number[];
    label?: (pkt: Packet<P>) => string | undefined;
    color?: (pkt: Packet<P>) => string | undefined;
    /** Only these packets. */
    filter?: (pkt: Packet<P>) => boolean;
  } = {},
): { names: string[]; messages: StMessage[]; marks: StMark[] } {
  const order = opts.nodes ?? net.names.map((_, i) => i);
  const row = new Map(order.map((n, i) => [n, i]));
  const pkts = new Map<number, Packet<P>>();
  for (const e of net.trace) if ("pkt" in e) pkts.set(e.pkt.id, e.pkt);
  const messages: StMessage[] = [];
  const marks: StMark[] = [];
  for (const h of net.hops) {
    const pkt = pkts.get(h.pkt);
    if (!pkt || (opts.filter && !opts.filter(pkt))) continue;
    const from = row.get(h.from), to = row.get(h.to);
    if (from === undefined || to === undefined) continue;
    const color = opts.color?.(pkt);
    if (h.lost && h.txEnd === h.txStart) {
      marks.push({ node: from, t: h.txStart, shape: "cross", color: color ?? "var(--c4)", label: h.lost === "queue" ? "queue full" : undefined });
      continue;
    }
    messages.push({ from, to, sentAt: h.txStart, deliveredAt: h.arriveAt, label: opts.label?.(pkt), color });
  }
  return { names: order.map((n) => net.names[n]!), messages, marks };
}

const FIELD_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];

/**
 * Rows of `rowBits` bits (32 by default, 16 below 480 px wide). Each field is a box as wide as its bits; a field that
 * crosses a row end continues on the next row. Labels that do not fit fall back to `short`, then to nothing
 * (the name stays in the tooltip).
 */
export function HeaderDiagram({
  fields,
  selected,
  onSelect,
  rowBits,
  values,
  colors,
}: {
  fields: Field[];
  selected?: number;
  onSelect?: (i: number) => void;
  rowBits?: number;
  /** Text under each name, such as the decoded value. Default: the field's value in decimal, if it has one. */
  values?: (string | undefined)[];
  /** A color per field. Default: a repeating set of four. */
  colors?: (string | undefined)[];
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(280, width);
  const per = rowBits ?? (w < 480 ? 16 : 32);
  const ruler = 16, rowH = 40, left = 0;
  const bitW = (w - left - 1) / per;
  const offs = fieldOffsets(fields);
  const total = fields.reduce((s, f) => s + f.bits, 0);
  const rows = Math.ceil(total / per);
  const h = ruler + rows * rowH + 1;
  const boxes: { i: number; x: number; y: number; bw: number }[] = [];
  fields.forEach((f, i) => {
    let at = offs[i]!, left_ = f.bits;
    while (left_ > 0) {
      const r = Math.floor(at / per), c = at % per;
      const n = Math.min(left_, per - c);
      boxes.push({ i, x: left + c * bitW, y: ruler + r * rowH, bw: n * bitW });
      at += n;
      left_ -= n;
    }
  });
  const text = (f: Field, bw: number, size: number) => {
    const fits = (s: string) => s.length * size * 0.6 + 6 <= bw;
    if (fits(f.name)) return f.name;
    if (f.short && fits(f.short)) return f.short;
    return "";
  };
  const valueText = (i: number) => {
    if (values) return values[i];
    const v = fields[i]!.value;
    return typeof v === "number" || typeof v === "bigint" ? String(v) : undefined;
  };
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="header layout" style={{ display: "block" }}>
        {Array.from({ length: per / 4 + 1 }, (_, k) => k * 4).filter((b) => b < per).map((b) => (
          <text key={b} x={left + b * bitW + 2} y={11} fontSize="9.5" fill="var(--faint)">{b}</text>
        ))}
        {boxes.map((b, k) => {
          const f = fields[b.i]!;
          const c = colors?.[b.i] ?? FIELD_COLORS[b.i % FIELD_COLORS.length]!;
          const on = selected === b.i;
          const name = text(f, b.bw, 11);
          const val = valueText(b.i);
          const showVal = val !== undefined && val.length * 10.5 * 0.6 + 6 <= b.bw;
          return (
            <g key={k} onClick={onSelect ? () => onSelect(b.i) : undefined} style={{ cursor: onSelect ? "pointer" : undefined }}>
              <title>{`${f.name} (${f.bits} bit${f.bits === 1 ? "" : "s"})${f.note ? `: ${f.note}` : ""}`}</title>
              <rect x={b.x + 0.5} y={b.y + 0.5} width={Math.max(1, b.bw - 1)} height={rowH - 1} rx={3}
                fill={`color-mix(in srgb, ${c} ${on ? 34 : 13}%, var(--bg))`} stroke={on ? c : "var(--border)"} strokeWidth={on ? 1.6 : 1} />
              {name && <text x={b.x + b.bw / 2} y={b.y + (showVal ? 17 : 24)} textAnchor="middle" fontSize="11" fill="var(--fg)">{name}</text>}
              {showVal && <text x={b.x + b.bw / 2} y={b.y + 31} textAnchor="middle" fontSize="10.5" fill="var(--muted)" style={{ fontVariantNumeric: "tabular-nums" }}>{val}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
