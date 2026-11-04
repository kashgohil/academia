/**
 * Lazy binding, run from the real bytes of the ELF image in elf.ts.
 *
 * A small interpreter decodes the few x86-64 instructions in .text and .plt and follows them.
 * The parts in other files (the resolver, puts, exit) are model steps at fixed addresses.
 */
import { buildElf, PIE_BASE, LDSO_BASE, LIBC_BASE, type ElfImage, R_X86_64_JUMP_SLOT } from "./elf";

export const RESOLVER = LDSO_BASE + 0x1a000; // _dl_runtime_resolve in the model.
export const PUTS = LIBC_BASE + 0x80000;
export const EXIT = LIBC_BASE + 0x47000;
const LINK_MAP = 0x7ffff7ffe000;

export type PltRegion = "text" | "plt" | "resolver" | "libc";

export interface PltStep {
  rip: number;
  region: PltRegion;
  asm: string;
  text: string;
  /** Values of GOT[3] (puts) and GOT[4] (exit). */
  gotPuts: number;
  gotExit: number;
  gotLinkMap: number;
  gotResolver: number;
  stack: string[];
  /** Calls finished so far. */
  output: string[];
  resolverRuns: number;
}

export interface PltRun { steps: PltStep[]; resolverRuns: number; base: number }

/** Library symbols that the model libc exports. */
const LIBC: Record<string, number> = { puts: PUTS, exit: EXIT };

/**
 * @param bindNow resolve all slots at load time, as with LD_BIND_NOW=1 or the linker flag -z now
 */
export function runPlt(bindNow = false, img: ElfImage = buildElf(), base = PIE_BASE): PltRun {
  const b = img.bytes;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // Writable memory: only the GOT changes, so keep it apart from the file bytes.
  const gotAddr = base + img.sym.gotPlt;
  const got: number[] = [];
  for (let i = 0; i < 5; i++) got.push(Number(v.getBigUint64(img.sym.gotPlt - 0x2000 + 8 * i, true)));
  // ld.so at startup: fill GOT[1] and GOT[2], and add the load base to the lazy slots.
  got[0] = base + got[0]!;
  got[1] = LINK_MAP;
  got[2] = RESOLVER;
  got[3] = base + got[3]!;
  got[4] = base + got[4]!;

  const fileOff = (addr: number) => {
    const rel = addr - base;
    for (const p of img.phdrs) if (p.type === 1 && rel >= p.vaddr && rel < p.vaddr + p.filesz) return rel - p.vaddr + p.offset;
    throw new Error(`unmapped address 0x${addr.toString(16)}`);
  };
  const readSlot = (addr: number) => {
    const i = (addr - gotAddr) / 8;
    if (!Number.isInteger(i) || i < 0 || i >= got.length) throw new Error(`not a GOT slot: 0x${addr.toString(16)}`);
    return got[i]!;
  };
  const cstr = (o: number) => { let s = ""; while (b[o]) s += String.fromCharCode(b[o++]!); return s; };
  /** Reads relocation n of .rela.plt and the symbol it names, from the file bytes. */
  const relocation = (n: number) => {
    const o = img.sym.relaPlt + 24 * n;
    const offset = Number(v.getBigUint64(o, true));
    const info = v.getBigUint64(o + 8, true);
    if (Number(info & 0xffffffffn) !== R_X86_64_JUMP_SLOT) throw new Error("not a jump slot");
    const sym = Number(info >> 32n);
    const name = cstr(img.sym.dynstr + v.getUint32(img.sym.dynsym + 24 * sym, true));
    return { slot: base + offset, name };
  };
  const resolve = (n: number) => {
    const r = relocation(n);
    const addr = LIBC[r.name];
    if (addr === undefined) throw new Error(`undefined symbol ${r.name}`);
    got[(r.slot - gotAddr) / 8] = addr;
    return r;
  };
  if (bindNow) { resolve(0); resolve(1); }

  const stack: string[] = [];
  const steps: PltStep[] = [];
  const output: string[] = [];
  let rip = base + img.entry;
  let resolverRuns = 0;
  let done = false;
  const region = (a: number): PltRegion => {
    if (a === RESOLVER) return "resolver";
    if (a === PUTS || a === EXIT) return "libc";
    const rel = a - base;
    return rel >= img.sym.plt0 && rel < img.sym.start ? "plt" : "text";
  };
  const sym = (a: number) => {
    const rel = a - base;
    if (rel === img.sym.plt0) return "PLT0";
    if (rel === img.sym.pltPuts) return "puts@plt";
    if (rel === img.sym.pltPuts + 6) return "puts@plt+6";
    if (rel === img.sym.pltExit) return "exit@plt";
    if (rel === img.sym.pltExit + 6) return "exit@plt+6";
    if (a === PUTS) return "puts";
    if (a === EXIT) return "exit";
    if (a === RESOLVER) return "_dl_runtime_resolve";
    return `0x${a.toString(16)}`;
  };
  const rec = (at: number, asm: string, text: string) => steps.push({
    rip: at, region: region(at), asm, text,
    gotLinkMap: got[1]!, gotResolver: got[2]!, gotPuts: got[3]!, gotExit: got[4]!,
    stack: [...stack], output: [...output], resolverRuns,
  });

  let guard = 0;
  while (!done && guard++ < 100) {
    const at = rip;
    if (at === RESOLVER) {
      stack.pop(); // link map
      const idx = Number(stack.pop()!.replace("reloc index ", ""));
      resolverRuns++;
      const r = resolve(idx);
      const target = LIBC[r.name]!;
      rec(at, "_dl_runtime_resolve", `The resolver saves the argument registers, reads relocation ${idx}, and searches the loaded files for ${r.name}. It writes the address into GOT[${(r.slot - gotAddr) / 8}] and jumps to ${r.name}.`);
      rip = target;
      continue;
    }
    if (at === PUTS) {
      output.push("hi from lab");
      const ret = stack.pop()!;
      rec(at, "puts (in libc)", "The real puts runs and prints the line. Then it returns to the caller in .text.");
      rip = Number(ret);
      continue;
    }
    if (at === EXIT) {
      rec(at, "exit (in libc)", "exit runs atexit handlers, flushes stdout and calls exit_group. It does not return.");
      done = true;
      continue;
    }
    const o = fileOff(at);
    const op = b[o]!;
    if (op === 0x48 && b[o + 1] === 0x8d && b[o + 2] === 0x3d) {
      rec(at, "lea rdi, [rip+msg]", "This loads the address of the string as the first argument.");
      rip = at + 7;
    } else if (op === 0xe8) {
      const target = at + 5 + v.getInt32(o + 1, true);
      stack.push(String(at + 5));
      rec(at, `call ${sym(target)}`, `The call pushes the return address and goes to ${sym(target)}. The linker fixed this offset, because the PLT is in the same file.`);
      rip = target;
    } else if (op === 0xff && b[o + 1] === 0x25) {
      const slot = at + 6 + v.getInt32(o + 2, true);
      const target = readSlot(slot);
      const i = (slot - gotAddr) / 8;
      const text = target === at + 6
        ? `GOT[${i}] still points at the next instruction, so this jump goes nowhere new. The function is not bound yet.`
        : region(target) === "resolver"
          ? "GOT[2] holds the address of the resolver in ld.so."
          : `GOT[${i}] holds the real address, so the CPU goes straight to ${sym(target)}. No lookup runs.`;
      rec(at, `jmp [GOT+${8 * i}]`, text);
      rip = target;
    } else if (op === 0x68) {
      const idx = v.getInt32(o + 1, true);
      stack.push(`reloc index ${idx}`);
      rec(at, `push ${idx}`, `This pushes the relocation index, so that the resolver knows which function is needed.`);
      rip = at + 5;
    } else if (op === 0xe9) {
      const target = at + 5 + v.getInt32(o + 1, true);
      rec(at, `jmp ${sym(target)}`, "This jumps to the shared stub.");
      rip = target;
    } else if (op === 0xff && b[o + 1] === 0x35) {
      const slot = at + 6 + v.getInt32(o + 2, true);
      stack.push("link map");
      rec(at, "push [GOT+8]", `This pushes GOT[1], the link map. It tells the resolver which file made the call. Value 0x${readSlot(slot).toString(16)}.`);
      rip = at + 6;
    } else if (op === 0x31 && b[o + 1] === 0xff) {
      rec(at, "xor edi, edi", "This sets the exit status to 0.");
      rip = at + 2;
    } else if (op === 0x0f && b[o + 1] === 0x1f) {
      rip = at + 4;
    } else {
      throw new Error(`unknown instruction at 0x${at.toString(16)}: ${op.toString(16)}`);
    }
  }
  return { steps, resolverRuns, base };
}

/** Instructions from `call puts@plt` up to the first instruction of puts, for each of the two calls. */
export function stepsToPuts(run: PltRun): number[] {
  const out: number[] = [];
  let count = -1;
  for (const s of run.steps) {
    if (s.asm === "call puts@plt") count = 0;
    if (count >= 0) {
      if (s.region === "libc") { out.push(count); count = -1; }
      else count++;
    }
  }
  return out;
}
