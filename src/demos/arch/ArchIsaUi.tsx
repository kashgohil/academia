/**
 * Small views shared by the ISA module's demos: machine-code listings for x86-64, AArch64 and RISC-V with their
 * bytes, and x86 bytes colored by instruction part (prefix, REX, opcode, ModRM, SIB, displacement, immediate).
 */
import type { CSSProperties, ReactNode } from "react";
import { MONO, mono, tint } from "../../kit";
import { decodeAt, type MInst, type PartKind } from "../../sims/arch/isa";
import { disasm, type Program } from "../../sims/arch/rv";

export const ISA_NAME = { x86: "x86-64", arm: "AArch64", rv: "RISC-V (RV32)" } as const;
export const ISA_COLOR = { x86: "var(--c1)", arm: "var(--c3)", rv: "var(--c2)" } as const;

export const PART_COLOR: Record<PartKind, string> = {
  prefix: "var(--c5)", rex: "var(--c4)", opcode: "var(--c1)", modrm: "var(--c3)", sib: "var(--c3)", disp: "var(--c2)", imm: "var(--c2)", unknown: "var(--faint)",
};
export const PART_LABEL: Record<PartKind, string> = {
  prefix: "prefix", rex: "REX", opcode: "opcode", modrm: "ModRM", sib: "SIB", disp: "displacement", imm: "immediate", unknown: "unknown",
};

const hex2 = (b: number) => b.toString(16).padStart(2, "0");

/** One byte as a small box. */
export function ByteBox({ b, color, dim, mark, title }: { b: number; color?: string; dim?: boolean; mark?: boolean; title?: string }) {
  return (
    <span title={title} style={{
      display: "inline-grid", placeItems: "center", width: 20, height: 18, fontSize: 10.5, fontFamily: MONO, borderRadius: 2,
      background: color ? tint(color, dim ? 10 : 28) : "var(--subtle)", color: dim ? "var(--muted)" : "var(--fg)",
      boxShadow: mark ? `inset 2px 0 0 var(--fg)` : undefined,
    }}>{hex2(b)}</span>
  );
}

/** The bytes of one x86 instruction, colored by part. */
export function X86Bytes({ bytes }: { bytes: number[] }) {
  const d = decodeAt(bytes, 0);
  const kindAt = (i: number) => d.parts.find((p) => i >= p.start && i < p.start + p.len)?.kind ?? "unknown";
  return (
    <span style={{ display: "inline-flex", gap: 1, flexWrap: "nowrap" }}>
      {bytes.map((b, i) => <ByteBox key={i} b={b} color={PART_COLOR[kindAt(i)]} title={PART_LABEL[kindAt(i)]} />)}
    </span>
  );
}

/** A machine-code listing: bytes, then the assembly text. x86 bytes are colored by part. */
export function MachineListing({ isa, insts, dimRet = true }: { isa: "x86" | "arm" | "rv"; insts: MInst[]; dimRet?: boolean }) {
  const cell: CSSProperties = { whiteSpace: "pre", padding: "1px 0", fontFamily: MONO, fontSize: 12 };
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", maxWidth: "100%" }}>
      <div style={{ display: "grid", gridTemplateColumns: isa === "x86" ? "max-content max-content" : "max-content max-content", columnGap: 10, alignItems: "center", minWidth: "max-content" }}>
        {insts.map((m, i) => {
          const isRet = dimRet && /^ret\b/.test(m.text.replace(/^\.\w+:\s*/, ""));
          return [
            <span key={`b${i}`} style={{ ...cell, opacity: isRet ? 0.5 : 1 }}>
              {isa === "x86" ? <X86Bytes bytes={m.bytes} /> : <span style={{ display: "inline-flex", gap: 1 }}>{m.bytes.map((b, k) => <ByteBox key={k} b={b} color={isa === "arm" ? ISA_COLOR.arm : ISA_COLOR.rv} />)}</span>}
            </span>,
            <span key={`t${i}`} style={{ ...cell, color: isRet ? "var(--muted)" : "var(--fg)" }}>{m.text}</span>,
          ];
        })}
      </div>
    </div>
  );
}

/** A labelled column header with a colored rule. */
export function IsaHead({ isa, children }: { isa: "x86" | "arm" | "rv"; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, borderTop: `3px solid ${ISA_COLOR[isa]}`, paddingTop: 4, marginBottom: 6, fontSize: 13 }}>
      <b>{ISA_NAME[isa]}</b>
      <span className="muted" style={{ fontSize: 12, ...mono }}>{children}</span>
    </div>
  );
}

/** The RISC-V function at label `fn` of a program, as listing rows (pseudo-instructions, label names for targets). */
export function rvListing(p: Program, from = "fn"): MInst[] {
  const out: MInst[] = [];
  const start = p.labels[from] ?? p.textBase;
  const name = (t: number) => Object.entries(p.labels).find(([k, v]) => v === t && k !== from)?.[0];
  for (let a = start; a < p.textBase + 4 * p.words.length; a += 4) {
    const i = (a - p.textBase) / 4, w = p.words[i]!;
    out.push({ text: disasm(p.insts[i]!, a, { pseudo: true, symbol: name }), bytes: [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24] });
  }
  return out;
}
