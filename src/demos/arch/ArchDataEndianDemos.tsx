/** Demos for the lesson on endianness. */
import { useState } from "react";
import { Demo, Param, Stats, Legend, range, seg, useParams, Note, SectionLabel, Banner, MiniTable, mono, useWidth, pct, tint } from "../../kit";
import { HEADER, SWAP_OPS, layout, roundTrip, span, splitFraction, swapOp, toBytes, bitMap, type Order, type Encode, type SwapOp } from "../../sims/arch/data";
import { BitRow, ByteBox, Readout, cellsOf } from "./ArchDataUi";

const FIELD_COLORS: Record<string, string> = { magic: "var(--c1)", version: "var(--c2)", flags: "var(--c3)", kind: "var(--c5)", id: "var(--c4)", ratio: "var(--c3)", delta: "var(--c2)" };
const hex = (v: bigint | number, n: number) => `0x${v.toString(16).toUpperCase().padStart(n, "0")}`;

// ---------------------------------------------------------------- a struct in memory

export function ArchDataStructDumpDemo() {
  const p = useParams("structdump", {
    delta: range({ label: "delta (int32_t)", min: -1000, max: 1000, step: 1, default: -2 }),
    version: range({ label: "version (uint16_t)", min: 0, max: 65535, step: 1, default: 258, format: (v) => `${v} = ${hex(v, 4)}` }),
  });
  const values = { magic: 0x0a000001, version: p.values.version, flags: 0x80, kind: 7, id: 0x1122334455667788n, ratio: 1.5, delta: p.values.delta };
  const [sel, setSel] = useState(0);
  const rows: [Order, string][] = [["le", "Little-endian (x86-64, and Arm and RISC-V as Linux runs them)"], ["be", "Big-endian (network order, IBM z, SPARC)"]];
  const cell = layout(HEADER, values, "le")[sel]!;
  const f = HEADER.find((x) => x.name === cell.field)!;
  return (
    <Demo
      title="One struct, two byte orders"
      controls={<>
        <Param spec={p.schema.delta} value={p.values.delta} onChange={(v) => p.set("delta", v as number)} />
        <Param spec={p.schema.version} value={p.values.version} onChange={(v) => p.set("version", v as number)} />
      </>}
    >
      <pre style={{ fontSize: 11.5, margin: "0 0 8px", overflowX: "auto", ...mono }}>{`struct Header {     // 24 bytes, no padding
  uint32_t magic;   // +0  = 0x0A000001
  uint16_t version; // +4  = ${hex(values.version, 4)}
  uint8_t  flags;   // +6  = 0x80
  uint8_t  kind;    // +7  = 7
  uint64_t id;      // +8  = 0x1122334455667788
  float    ratio;   // +16 = 1.5
  int32_t  delta;   // +20 = ${values.delta}
};`}</pre>
      {rows.map(([order, label]) => {
        const bytes = layout(HEADER, values, order);
        return (
          <div key={order} style={{ marginBottom: 10 }}>
            <SectionLabel>{label}</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 32px)", gap: "6px 3px" }}>
              {bytes.map((b, i) => (
                <ByteBox key={i} value={b.value} color={FIELD_COLORS[b.field]} on={i === sel} onClick={() => setSel(i)} caption={`+${i}`} />
              ))}
            </div>
          </div>
        );
      })}
      <Legend items={HEADER.map((h) => ({ label: h.name, color: FIELD_COLORS[h.name]! }))} />
      <Banner tone="info">
        Address +{sel} holds byte {cell.significance} of <b>{f.name}</b> ({f.size} bytes){f.size > 1 ? `, counted from the least significant byte = 0, in little-endian order. In big-endian order the same address holds byte ${f.size - 1 - cell.significance}.` : ". A single byte has no order."}
      </Banner>
      <Note>Click a byte. The fields keep the same offsets in both rows: only the order of the bytes inside each field changes.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- across a boundary

const CODE: Record<"w" | "r", Record<Encode, string>> = {
  w: { raw: "memcpy(buf, &x, 4);   // or fwrite(&x, 4, 1, f)", explicit: "buf[0] = x >> 24; buf[1] = x >> 16;\nbuf[2] = x >> 8;  buf[3] = x;" },
  r: { raw: "memcpy(&x, buf, 4);   // or *(uint32_t *)buf", explicit: "x = (uint32_t)buf[0] << 24 | buf[1] << 16\n  | buf[2] << 8 | buf[3];" },
};

export function ArchDataBoundaryDemo() {
  const p = useParams("boundary", {
    wo: seg<Order>("Writer CPU", [["le", "little-endian"], ["be", "big-endian"]], "le"),
    wh: seg<Encode>("Writer code", [["raw", "copies memory"], ["explicit", "shifts (big-endian)"]], "raw"),
    ro: seg<Order>("Reader CPU", [["le", "little-endian"], ["be", "big-endian"]], "be"),
    rh: seg<Encode>("Reader code", [["raw", "copies memory"], ["explicit", "shifts (big-endian)"]], "raw"),
  });
  const x = 0x0a000001n;
  const { wo, wh, ro, rh } = p.values;
  const t = roundTrip(x, wo, wh, ro, rh);
  const mem = toBytes(x, 4, wo);
  return (
    <Demo
      title="Send a 32-bit value across a boundary"
      controls={<>
        <Param spec={p.schema.wo} value={wo} onChange={(v) => p.set("wo", v as Order)} />
        <Param spec={p.schema.wh} value={wh} onChange={(v) => p.set("wh", v as Encode)} />
        <Param spec={p.schema.ro} value={ro} onChange={(v) => p.set("ro", v as Order)} />
        <Param spec={p.schema.rh} value={rh} onChange={(v) => p.set("rh", v as Encode)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <div>
          <SectionLabel>Writer: x = 0x0A000001</SectionLabel>
          <div style={{ display: "flex", gap: 3 }}>{mem.map((b, i) => <ByteBox key={i} value={b} color="var(--c1)" caption={`+${i}`} />)}</div>
          <pre style={{ fontSize: 11, margin: "6px 0 0", whiteSpace: "pre-wrap", ...mono }}>{CODE.w[wh]}</pre>
        </div>
        <div>
          <SectionLabel>File or packet</SectionLabel>
          <div style={{ display: "flex", gap: 3 }}>{t.wire.map((b, i) => <ByteBox key={i} value={b} color="var(--c2)" caption={`+${i}`} />)}</div>
        </div>
        <div>
          <SectionLabel>Reader</SectionLabel>
          <pre style={{ fontSize: 11, margin: "0 0 6px", whiteSpace: "pre-wrap", ...mono }}>{CODE.r[rh]}</pre>
          <div style={{ fontSize: 13, ...mono }}>x = {hex(t.read, 8)}</div>
        </div>
      </div>
      <Banner ok={t.ok}>
        {t.ok
          ? wh === "explicit" && rh === "explicit" ? "Correct on every pair of machines: both sides name the byte order in the code." : "Correct, but only because the two sides happen to agree. Change one CPU and it breaks."
          : `Wrong: the reader gets ${hex(t.read, 8)} = ${t.read}. The bytes were in one order and the code read them in the other.`}
      </Banner>
      <Note>Inside one machine, byte order is invisible: loads and stores use the same order. It matters only when bytes cross a boundary: a file, a socket, or a pointer cast that reads memory as another type.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- swap instructions

export function ArchDataSwapDemo() {
  const p = useParams("bswap", {
    op: seg<SwapOp>("Instruction", SWAP_OPS.map((o) => [o.op, o.label]), "rev"),
    w: seg<"16" | "32" | "64">("Register width", [["16", "16"], ["32", "32"], ["64", "64"]], "32"),
  });
  const w = Number(p.values.w), op = p.values.op;
  const info = SWAP_OPS.find((o) => o.op === op)!;
  const x = BigInt.asUintN(w, 0x0123456789abcdefn);
  const y = swapOp(op, x, w);
  const n = w / 8;
  const map = bitMap(op, w);
  const [ref, width] = useWidth<HTMLDivElement>(500);
  const box = Math.min(40, Math.floor((Math.max(260, width) - 10) / n) - 4);
  const W = n * (box + 4);
  const cx = (j: number) => (n - 1 - j) * (box + 4) + box / 2 + 2; // byte j = significance; most significant on the left
  const src = toBytes(x, n, "le"), dst = toBytes(y, n, "le");
  return (
    <Demo
      title="Byte swap and bit reverse instructions"
      controls={<>
        <Param spec={p.schema.op} value={op} onChange={(v) => p.set("op", v as SwapOp)} />
        <Param spec={p.schema.w} value={p.values.w} onChange={(v) => p.set("w", v as "16" | "32" | "64")} />
      </>}
    >
      <div ref={ref} style={{ width: "100%", overflowX: "auto" }}>
        <svg width={W} height={130} role="img" aria-label="where each byte goes">
          {Array.from({ length: n }, (_, j) => {
            const from = Math.floor(map[8 * j]! / 8); // destination byte j takes source byte `from`
            return <line key={j} x1={cx(from)} y1={36} x2={cx(j)} y2={92} stroke={`var(--c${(from % 5) + 1})`} strokeWidth={2} />;
          })}
          {[[src, 6], [dst, 94]].map(([bytes, y0]) => (bytes as number[]).map((b, j) => (
            <g key={`${y0}-${j}`}>
              <rect x={cx(j) - box / 2} y={y0 as number} width={box} height={28} rx={4} fill={tint(`var(--c${(((y0 as number) === 6 ? j : Math.floor(map[8 * j]! / 8)) % 5) + 1})`, 25)} stroke="var(--border)" />
              <text x={cx(j)} y={(y0 as number) + 18} fontSize={12} textAnchor="middle" fill="var(--fg)" style={mono}>{b.toString(16).padStart(2, "0").toUpperCase()}</text>
            </g>
          )))}
        </svg>
      </div>
      <Readout label="before">{hex(x, w / 4)}</Readout>
      <Readout label="after">{hex(y, w / 4)}</Readout>
      <Banner tone="info"><b>{info.isa}</b>: {info.what}.</Banner>
      {(op === "brev8" || op === "rbit") && (
        <>
          <BitRow label="the low 16 bits before" cells={cellsOf(x & 0xffffn, 16, (i) => (i < 8 ? "var(--c1)" : "var(--c2)"))} />
          <BitRow label="the low 16 bits after" cells={cellsOf(y & 0xffffn, 16, (i) => (i < 8 ? "var(--c1)" : "var(--c2)"))} />
        </>
      )}
      <Note>Byte order and bit order are different things. Memory addresses bytes, not bits, so a CPU has no bit order in memory. Bit order matters on a serial wire, and in some checksums and codecs.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- unaligned access

export function ArchDataUnalignedDemo() {
  const p = useParams("unaligned", {
    addr: range({ label: "Start address", min: 0, max: 127, step: 1, default: 60 }),
    size: seg<"2" | "4" | "8" | "16" | "32" | "64">("Access size (bytes)", [["2", "2"], ["4", "4"], ["8", "8"], ["16", "16"], ["32", "32"], ["64", "64"]], "8"),
  });
  const size = Number(p.values.size);
  const addr = Math.min(p.values.addr, 128 - size);
  const s = span(addr, size);
  const [ref, w] = useWidth<HTMLDivElement>(500);
  const W = Math.max(260, w), cw = (W - 4) / 64;
  return (
    <Demo
      title="An access that crosses a cache line"
      controls={<>
        <Param spec={{ ...p.schema.addr, max: 128 - size }} value={addr} onChange={(v) => p.set("addr", v as number)} />
        <Param spec={p.schema.size} value={p.values.size} onChange={(v) => p.set("size", v as typeof p.values.size)} />
      </>}
    >
      <div ref={ref} style={{ width: "100%" }}>
        <svg width={W} height={86} role="img" aria-label="two 64-byte cache lines">
          {[0, 1].map((line) => (
            <g key={line}>
              <text x={2} y={line * 40 + 10} fontSize={10.5} fill="var(--muted)">{`line ${line}: bytes ${line * 64}–${line * 64 + 63}`}</text>
              {Array.from({ length: 64 }, (_, i) => {
                const a = line * 64 + i;
                const on = a >= addr && a < addr + size;
                return <rect key={i} x={2 + i * cw} y={line * 40 + 16} width={Math.max(1, cw - 1)} height={16} fill={on ? (s.splitsLine ? "var(--c4)" : "var(--c3)") : a % size === 0 ? "var(--border)" : "var(--subtle)"} />;
              })}
            </g>
          ))}
        </svg>
      </div>
      <Stats items={[
        { label: "naturally aligned", value: s.aligned ? "yes" : "no" },
        { label: "cache lines touched", value: String(s.lines.length) },
        { label: "start addresses that split", value: pct(splitFraction(size), 1) },
      ]} />
      <Banner ok={!s.splitsLine}>
        {s.splitsLine
          ? `Bytes ${addr}–${addr + size - 1} cross the line boundary at 64. The core must read two lines and merge them. If the two lines are on different pages, it also needs two translations.`
          : s.aligned ? "Aligned: the access stays inside one line, and inside one page." : "Not aligned, but inside one line. On most modern x86 and Arm cores this costs about the same as an aligned access."}
      </Banner>
      <MiniTable head={["access size", "share of byte addresses that split a 64-byte line"]} rows={[2, 4, 8, 16, 32, 64].map((z) => [`${z} B`, pct(splitFraction(z), 1)])} highlight={[2, 4, 8, 16, 32, 64].indexOf(size)} />
      <Note>Darker grey cells mark aligned start addresses for this size. An aligned access of 64 bytes or less never crosses a 64-byte line.</Note>
    </Demo>
  );
}
