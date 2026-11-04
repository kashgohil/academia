/**
 * A small linker layout model: section order, base address, page alignment. It computes the addresses,
 * the symbols that a linker script defines, the PT_LOAD segments, the file size and the problems a real link would show.
 * Section sizes are model inputs.
 */
import { alignUp } from "../../allocextrasA";
import { isCanonical } from "../vm/addr";

export const PAGE = 4096;

export type SectionName = ".text" | ".rodata" | ".data" | ".bss";
export interface SectionSpec { name: SectionName; size: number; align: number; perms: "r-x" | "r--" | "rw-"; nobits: boolean }

/** MODEL INPUT: section sizes of a small kernel. */
export const SECTIONS: SectionSpec[] = [
  { name: ".text", size: 0x3200, align: 16, perms: "r-x", nobits: false },
  { name: ".rodata", size: 0x0800, align: 16, perms: "r--", nobits: false },
  { name: ".data", size: 0x0400, align: 8, perms: "rw-", nobits: false },
  { name: ".bss", size: 0x6000, align: 16, perms: "rw-", nobits: true },
];
export const DEFAULT_ORDER: SectionName[] = [".text", ".rodata", ".data", ".bss"];

export const BASE_OPTIONS: { base: bigint; label: string }[] = [
  { base: 0xffffffff80000000n, label: "0xFFFFFFFF80000000 (top 2 GiB)" },
  { base: 0x100000n, label: "0x100000 (1 MiB, identity)" },
  { base: 0xffff800000100000n, label: "0xFFFF800000100000 (direct map)" },
  { base: 0x0000800000000000n, label: "0x0000800000000000 (non-canonical)" },
];

export interface Placed extends SectionSpec { vma: bigint; end: bigint; pad: number; fileOff: number }
export interface LoadSeg { perms: string; vaddr: bigint; memsz: number; filesz: number; offset: number; sections: SectionName[] }
export interface LinkProblem { level: "error" | "warn"; text: string }

export interface LinkResult {
  placed: Placed[];
  segments: LoadSeg[];
  symbols: { name: string; addr: bigint }[];
  problems: LinkProblem[];
  fileBytes: number;
  memBytes: number;
  /** 4 KiB pages that hold both W and X rights. */
  wxPages: number;
  script: string;
}

const U64 = (1n << 64n) - 1n;
const pageOf = (a: bigint) => a >> 12n;
const unionPerms = (a: string, b: string) => [0, 1, 2].map((i) => (a[i] !== "-" ? a[i] : b[i])).join("");

/** Top 2 GiB, or low 2 GiB: a sign-extended 32-bit address can reach both. */
export const fitsAbs32S = (a: bigint) => (a & U64) >= 0xffffffff80000000n || (a & U64) < 0x80000000n;

export function layout(order: readonly SectionName[], base: bigint, pageAlign: boolean): LinkResult {
  const specs = order.map((n) => SECTIONS.find((s) => s.name === n)!);
  const placed: Placed[] = [];
  let at = base;
  let last: SectionSpec | null = null;
  for (const s of specs) {
    const needPage = pageAlign && last !== null && last.perms !== s.perms;
    const al = BigInt(needPage ? PAGE : s.align);
    const addr = (at + al - 1n) & ~(al - 1n);
    placed.push({ ...s, vma: addr, end: addr + BigInt(s.size), pad: Number(addr - at), fileOff: 0 });
    at = addr + BigInt(s.size);
    last = s;
  }

  // Page rights are the union of the rights of all sections that touch the page.
  const pagePerm = new Map<bigint, string>();
  for (const p of placed) for (let g = pageOf(p.vma); g <= pageOf(p.end - 1n); g++) pagePerm.set(g, unionPerms(pagePerm.get(g) ?? "---", p.perms));
  const wxPages = [...pagePerm.values()].filter((x) => x[1] === "w" && x[2] === "x").length;

  // Sections that share a page or have the same rights go in one PT_LOAD.
  const groups: Placed[][] = [];
  for (const p of placed) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (g && prev && (prev.perms === p.perms || pageOf(prev.end - 1n) === pageOf(p.vma))) g.push(p);
    else groups.push([p]);
  }
  let offset = alignUp(64 + 56 * groups.length, PAGE);
  const segments: LoadSeg[] = [];
  for (const g of groups) {
    const vaddr = g[0]!.vma;
    const end = g[g.length - 1]!.end;
    // The file must hold zeros for a .bss that has file-backed sections after it in one segment.
    let lastFile = -1;
    g.forEach((p, i) => { if (!p.nobits) lastFile = i; });
    const filesz = lastFile < 0 ? 0 : Number(g[lastFile]!.end - vaddr);
    const memsz = Number(end - vaddr);
    offset = alignUp(offset, PAGE) + Number(vaddr & 0xfffn);
    for (const p of g) p.fileOff = p.nobits && g.indexOf(p) > lastFile ? offset + filesz : offset + Number(p.vma - vaddr);
    segments.push({ perms: g.reduce((a, p) => unionPerms(a, p.perms), "---"), vaddr, memsz, filesz, offset, sections: g.map((p) => p.name) });
    offset += filesz;
  }
  const fileBytes = offset;
  const memBytes = Number(placed[placed.length - 1]!.end - base);

  const find = (n: SectionName) => placed.find((p) => p.name === n)!;
  const symbols = [
    { name: "_kernel_start", addr: base },
    { name: "_start (ENTRY)", addr: find(".text").vma },
    { name: "__text_end", addr: find(".text").end },
    { name: "__bss_start", addr: find(".bss").vma },
    { name: "__bss_end", addr: find(".bss").end },
    { name: "_kernel_end", addr: placed[placed.length - 1]!.end },
  ];

  const problems: LinkProblem[] = [];
  if (!isCanonical(base)) problems.push({ level: "error", text: "The base is not canonical. Each fetch at this address raises #GP, so the kernel dies at its first instruction." });
  else if (!fitsAbs32S(base)) problems.push({ level: "error", text: "A kernel code model uses signed 32-bit absolute addresses. This base is outside the reach of 2 GiB, so ld prints: relocation truncated to fit: R_X86_64_32S." });
  if (wxPages > 0) problems.push({ level: "warn", text: `${wxPages} page(s) hold both code and writable data, so these pages must be RWX. Recent ld prints: LOAD segment with RWX permissions.` });
  const bssIdx = order.indexOf(".bss");
  if (bssIdx !== order.length - 1) {
    const afterSameSeg = segments.some((s) => s.sections.includes(".bss") && s.sections.indexOf(".bss") < s.sections.length - 1);
    problems.push({ level: "warn", text: afterSameSeg ? ".bss is not last, and file-backed bytes follow it in one segment. The file must now store its zeros." : ".bss is not last. Check that the code that clears it uses the symbols, and not an assumed order." });
  }
  const script = [
    "ENTRY(_start)",
    "SECTIONS {",
    `  . = 0x${base.toString(16)};`,
    "  _kernel_start = .;",
    ...order.flatMap((n, i) => {
      const p = placed[i]!;
      const lines: string[] = [];
      if (pageAlign && i > 0 && placed[i - 1]!.perms !== p.perms) lines.push("  . = ALIGN(4K);");
      if (n === ".bss") lines.push("  .bss : { __bss_start = .; *(.bss .bss.*) *(COMMON) __bss_end = .; }");
      else if (n === ".text") lines.push("  .text : { *(.text .text.*) __text_end = .; }");
      else lines.push(`  ${n} : { *(${n} ${n}.*) }`);
      return lines;
    }),
    "  _kernel_end = .;",
    "}",
  ].join("\n");
  return { placed, segments, symbols, problems, fileBytes, memBytes, wxPages, script };
}
