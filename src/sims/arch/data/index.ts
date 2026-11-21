/**
 * Architecture → Data: how the machine stores numbers and text as bits. Pure TypeScript, no React.
 *
 * - bits.ts:   words of 8–64 bits as bigints, bases, bit operations (masks, shifts, popcount, x & (x − 1)),
 *              how fast counters wrap, and `xxd`-style hex dumps (with an example ELF header).
 * - twos.ts:   two's complement: the adder with x86 flags (CF, OF, SF, ZF), negation, sign and zero extension,
 *              arithmetic and logical shifts, division edge cases per ISA and language, overflow per language,
 *              the RISC-V overflow-check sequences, and the number wheel.
 * - float.ts:  any IEEE-style binary format (binary64/32/16, bfloat16, OCP FP8 E4M3/E5M2, toy formats):
 *              exact decode, exact rounding in the five IEEE modes, one-rounding add/mul/fma, ULPs, exact
 *              decimal expansions, format statistics, and summation order in binary32.
 * - endian.ts: byte order of values and structs, byte-swap and bit-reverse instructions, decoding across a
 *              boundary (raw copy vs explicit big-endian), and line and page splits of unaligned accesses.
 * - utf.ts:    UTF-8 and UTF-16 encoders with bit placement, a WHATWG UTF-8 decoder traced byte by byte,
 *              the four lengths of a string, and sort order by encoding.
 */
export * from "./bits";
export * from "./twos";
export * from "./float";
export * from "./endian";
export * from "./utf";
