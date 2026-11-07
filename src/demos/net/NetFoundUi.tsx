/**
 * Views shared by the Networking foundations demos: a hex dump colored by layer, a bar of a packet's bytes by
 * layer, and lanes of busy time on links.
 */
import type { ReactNode } from "react";
import { MONO, tint, useWidth } from "../../kit";
import type { LayerName, Span } from "../../sims/net/foundations";

export const LAYER_COLOR: Record<LayerName, string> = {
  preamble: "var(--faint)",
  eth: "var(--c1)",
  ip: "var(--c2)",
  tcp: "var(--c3)",
  app: "var(--c5)",
  pad: "var(--faint)",
  fcs: "var(--c1)",
  ifg: "var(--faint)",
};

export const LAYER_LABEL: Record<LayerName, string> = {
  preamble: "preamble + SFD",
  eth: "Ethernet header",
  ip: "IPv4 header",
  tcp: "TCP header",
  app: "HTTP request",
  pad: "padding",
  fcs: "FCS",
  ifg: "interframe gap",
};

const layerOf = (spans: Span[], i: number) => spans.find((s) => i >= s.start && i < s.start + s.len)?.layer;

/**
 * Bytes in rows, each byte tinted by the layer that wrote it. 16 bytes per row on wide screens, 8 on phones.
 * `marked` bytes (changed by the learner) get a strong outline.
 */
export function HexDump({ bytes, spans, selected, onSelect, marked, ascii = true }: {
  bytes: Uint8Array;
  spans: Span[];
  selected?: number;
  onSelect?: (i: number) => void;
  marked?: Set<number>;
  ascii?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const per = w >= 560 ? 16 : 8;
  const rows = Math.ceil(bytes.length / per);
  return (
    <div ref={ref} style={{ width: "100%", fontFamily: MONO, fontSize: 12, lineHeight: "20px" }}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: "var(--faint)", width: 34, flex: "none", fontSize: 11 }}>{(r * per).toString(16).padStart(4, "0")}</span>
          <span style={{ display: "flex", flexWrap: "nowrap" }}>
            {Array.from({ length: per }, (_, c) => {
              const i = r * per + c;
              if (i >= bytes.length) return <span key={c} style={{ width: 22 }} />;
              const layer = layerOf(spans, i);
              const color = layer ? LAYER_COLOR[layer] : "var(--faint)";
              const on = selected === i, mark = marked?.has(i);
              return (
                <span
                  key={c}
                  onClick={onSelect ? () => onSelect(i) : undefined}
                  title={layer ? `${LAYER_LABEL[layer]}, byte ${i}` : `byte ${i}`}
                  style={{
                    width: 22, textAlign: "center", cursor: onSelect ? "pointer" : undefined,
                    background: on ? tint(color, 55) : tint(color, 18),
                    outline: mark ? "2px solid var(--c4)" : on ? `1.5px solid ${color}` : undefined, outlineOffset: -2,
                    color: mark ? "var(--c4)" : "var(--fg)", fontWeight: mark ? 700 : 400,
                    borderRight: c % 4 === 3 ? "2px solid var(--bg)" : undefined,
                  }}
                >
                  {bytes[i]!.toString(16).padStart(2, "0")}
                </span>
              );
            })}
          </span>
          {ascii && (
            <span style={{ color: "var(--muted)", whiteSpace: "pre", fontSize: 11.5 }}>
              {Array.from(bytes.subarray(r * per, r * per + per), (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "·")).join("")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** One packet as a bar of its parts, each as wide as its bytes, with the name and size on top when it fits. */
export function LayerBar({ parts, total, height = 34 }: { parts: { layer: LayerName; bytes: number; label?: string; dim?: boolean }[]; total?: number; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const t = total ?? parts.reduce((s, p) => s + p.bytes, 0);
  return (
    <div ref={ref} style={{ display: "flex", width: "100%", height, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
      {parts.map((p, i) => {
        const px = (p.bytes / t) * w;
        const name = p.label ?? LAYER_LABEL[p.layer];
        const color = LAYER_COLOR[p.layer];
        return (
          <div key={i} title={`${name}: ${p.bytes} bytes`}
            style={{ width: `${(p.bytes / t) * 100}%`, minWidth: p.bytes > 0 ? 2 : 0, background: tint(color, p.dim ? 8 : 26), borderRight: i < parts.length - 1 ? `1px solid ${tint(color, 60)}` : undefined, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", overflow: "hidden", transition: "width 0.25s", fontSize: 11, lineHeight: "13px", color: "var(--fg)" }}>
            {height < 26 ? (
              px > (name.length + String(p.bytes).length + 1) * 6 + 8 ? <span style={{ whiteSpace: "nowrap" }}>{name} <span style={{ fontFamily: MONO, color: "var(--muted)" }}>{p.bytes}</span></span> : px > 30 ? <span style={{ fontFamily: MONO, color: "var(--muted)" }}>{p.bytes}</span> : null
            ) : (
              <>
                {px > name.length * 6 + 8 ? <span style={{ whiteSpace: "nowrap" }}>{name}</span> : null}
                {px > 30 ? <span style={{ fontFamily: MONO, color: "var(--muted)", whiteSpace: "nowrap" }}>{p.bytes}</span> : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A legend for layer colors, as small swatches. */
export const LayerKey = ({ layers }: { layers: LayerName[] }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 11.5, color: "var(--muted)", margin: "6px 0" }}>
    {layers.map((l) => (
      <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 10, height: 10, borderRadius: 2, background: tint(LAYER_COLOR[l], 45), border: `1px solid ${LAYER_COLOR[l]}` }} />
        {LAYER_LABEL[l]}
      </span>
    ))}
  </div>
);

const USER_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)"];
export const userColor = (u: number) => USER_COLORS[u % USER_COLORS.length]!;

/**
 * Busy time on links: one row per lane, a block per transmission, colored by the user that owns it.
 * Time runs left to right from 0 to `tEnd` ms.
 */
export function Lanes({ lanes, busy, tEnd, labels, rowH = 12, title }: {
  lanes: number;
  busy: { lane: number; user: number; t0: number; t1: number }[];
  tEnd: number;
  labels: string[];
  rowH?: number;
  title?: ReactNode;
}) {
  const [ref, w0] = useWidth<HTMLDivElement>();
  const w = Math.max(240, w0), left = 44, right = 6;
  const h = lanes * (rowH + 2) + 16;
  const x = (t: number) => left + (Math.min(t, tEnd) / tEnd) * (w - left - right);
  return (
    <div ref={ref} style={{ width: "100%" }}>
      {title && <div className="muted" style={{ fontSize: 12, margin: "2px 0 2px" }}>{title}</div>}
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ display: "block" }} role="img" aria-label="link busy time">
        {Array.from({ length: lanes }, (_, l) => (
          <g key={l}>
            <rect x={left} y={l * (rowH + 2)} width={w - left - right} height={rowH} fill="var(--subtle)" />
            <text x={left - 6} y={l * (rowH + 2) + rowH - 2} textAnchor="end" fontSize="10" fill="var(--muted)">{labels[l]}</text>
          </g>
        ))}
        {busy.filter((b) => b.t0 < tEnd).map((b, i) => (
          <rect key={i} x={x(b.t0)} y={b.lane * (rowH + 2)} width={Math.max(0.8, x(b.t1) - x(b.t0))} height={rowH} fill={userColor(b.user)} />
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text key={f} x={x(f * tEnd)} y={h - 3} fontSize="9.5" fill="var(--faint)" textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}>{Math.round(f * tEnd)}{f === 1 ? " ms" : ""}</text>
        ))}
      </svg>
    </div>
  );
}
