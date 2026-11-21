/**
 * Where the immediate bits of each RISC-V format come from, read from the shared decoder (`immOf` in
 * src/sims/arch/rv/isa.ts), and how many different sources feed each bit of the immediate that the core builds.
 *
 * The decoder needs one multiplexer (mux) per immediate bit. Its inputs are the different places that bit can come
 * from across the five formats with an immediate (I, S, B, U, J): an instruction bit, or the constant 0. Fewer
 * different sources mean smaller muxes. The RISC-V Unprivileged ISA manual (section "Immediate Encoding Variants")
 * says that the B and J layouts rotate bits for this reason. It also always puts the sign in instruction bit 31.
 *
 * A "naive" layout for comparison: B stores offset >> 1 as an S immediate, and J stores offset >> 1 contiguously in
 * bits 31:12, as U does. The two layouts encode the same values; only the wiring differs.
 */
import { immOf, type Format } from "../rv";

export type ImmFormat = Exclude<Format, "R">;
export const IMM_FORMATS: ImmFormat[] = ["I", "S", "B", "U", "J"];

/** source[k] = the instruction bit that gives immediate bit k, or -1 for the constant 0. */
export type Wiring = number[];

/** The wiring of a format, found by setting one instruction bit at a time and decoding. */
export function realWiring(fmt: ImmFormat): Wiring {
  const src = new Array<number>(32).fill(-1);
  for (let p = 0; p < 32; p++) {
    const raw = immOf(((1 << p) >>> 0), fmt);
    const imm = fmt === "U" ? raw << 12 : raw; // U: the core builds value << 12
    for (let k = 0; k < 32; k++) if ((imm >>> k) & 1) {
      // bit 31 sets every sign-extended bit too; a lower bit wins if two instruction bits claim one immediate bit
      if (src[k] === -1 || p < 31) src[k] = p;
    }
  }
  return src;
}

/** The naive layouts: I, S and U as RISC-V has them; B as S shifted by one; J as U-style contiguous bits. */
export function naiveWiring(fmt: ImmFormat): Wiring {
  if (fmt === "I" || fmt === "S" || fmt === "U") return realWiring(fmt);
  const src = new Array<number>(32).fill(-1);
  if (fmt === "B") {
    // offset[12:1] = S-immediate[11:0] = { inst[31:25], inst[11:7] }; sign from inst[31]
    const s = realWiring("S");
    for (let k = 1; k <= 12; k++) src[k] = s[k - 1]!;
    for (let k = 13; k < 32; k++) src[k] = 31;
  } else {
    // offset[20:1] = inst[31:12]; sign from inst[31]
    for (let k = 1; k <= 20; k++) src[k] = 11 + k;
    for (let k = 21; k < 32; k++) src[k] = 31;
  }
  return src;
}

/** For each immediate bit, the number of different sources (instruction bits or 0) across the five formats. */
export function muxInputs(layout: "real" | "naive"): number[] {
  const w = IMM_FORMATS.map((f) => (layout === "real" ? realWiring(f) : naiveWiring(f)));
  return Array.from({ length: 32 }, (_, k) => new Set(w.map((x) => x[k]!)).size);
}

/**
 * The mux inputs of the immediate decoder: the sum over the immediate bits that have more than one source. A bit
 * with one source (bit 31: always instruction bit 31) is a wire and needs no mux. A simple measure of the mux cost.
 */
export const totalMuxInputs = (layout: "real" | "naive") => muxInputs(layout).filter((n) => n > 1).reduce((a, b) => a + b, 0);
