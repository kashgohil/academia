/**
 * Temporary allocators: scratch arenas with save and restore marks, the conflict when a function puts its result
 * in the same arena that it uses as scratch, and a cost model for per-object malloc against an arena per request.
 *
 * Scratch arenas. Each arena is one 24-byte heap block of the shared memory machine (src/sims/sys/mem), so the bytes
 * are real bytes of the model. An arena has a position `pos`. `scratch_begin` saves pos (a mark) and
 * `scratch_end` puts pos back, so everything allocated after the mark is free again. The machine does NOT report a
 * read of such bytes: they are still inside a live heap block. That is the point of the demo. With `poison`, the
 * model marks the bytes past pos as poisoned, as ASan's manual poisoning (ASAN_POISON_MEMORY_REGION in
 * <sanitizer/asan_interface.h>) does, and a read of them reports use-after-poison.
 *
 * The program (C, in SCRATCH_SOURCE) is the pattern that scratch-arena code in C uses: `scratch_begin(conflict)`
 * returns a thread-local scratch arena that is not `conflict`. With one scratch arena there is no other arena to
 * return, so join_path's result lands after its own mark and dies at its scratch_end.
 *
 * Cost model (MODEL INPUTS, typical orders of magnitude, not measurements): malloc 20 ns, free 15 ns, an arena bump
 * 2 ns, an arena reset 50 ns, a copy 0.1 ns per byte. Objects that must live longer than the request are copied
 * out of the arena into malloc'd memory.
 */
import { Machine, array, T, hex, type Ptr } from "../mem";

export const ARENA_BYTES = 24;

export const SCRATCH_SOURCE = [
  "String join_path(Arena *out, String dir, String file) {",
  "    Scratch s = scratch_begin(out);       // a scratch arena, not out",
  "    String up = str_upper(s.arena, file); // temporary",
  "    String r = str_cat(out, dir, up);     // the result",
  "    scratch_end(s);                       // pos = mark",
  "    return r;",
  "}",
  "void caller(void) {",
  "    Scratch s = scratch_begin(NULL);",
  "    String p = join_path(s.arena, S(\"/tmp/\"), S(\"log\"));",
  "    String q = str_upper(s.arena, S(\"overwrite\"));",
  "    print(p);",
  "    scratch_end(s);",
  "}",
];

export interface ArenaView {
  name: string;
  addr: number;
  pos: number;
  marks: number[];
  /** The machine's bytes of the arena block and their init bits. */
  bytes: number[];
  init: boolean[];
  /** Who owns each byte range now (live allocations only). */
  owners: { from: number; to: number; label: string }[];
  poisonFrom: number | null;
}

export interface ScratchStep {
  line: number;
  caption: string;
  arenas: ArenaView[];
  /** The String p of the caller: where it points and what it reads now. */
  p?: { arena: string; from: number; len: number; text: string };
  report?: string;
  bad?: boolean;
}

interface Arena { name: string; block: Ptr; pos: number; marks: number[]; owners: { from: number; to: number; label: string }[]; poison: number | null }

export function runScratch(opts: { arenas: 1 | 2; poison: boolean }): ScratchStep[] {
  const m = new Machine();
  m.call("caller", []);
  const ar: Arena[] = (opts.arenas === 2 ? ["A", "B"] : ["A"]).map((name) => ({ name, block: m.malloc(ARENA_BYTES, 16, `arena ${name}`), pos: 0, marks: [], owners: [], poison: null }));
  const steps: ScratchStep[] = [];
  let p: { a: Arena; from: number; len: number } | null = null;
  const view = (): ArenaView[] => ar.map((a) => {
    const pk = m.peek(a.block.addr, ARENA_BYTES);
    return { name: a.name, addr: a.block.addr, pos: a.pos, marks: [...a.marks], bytes: pk.bytes, init: pk.init, owners: a.owners.map((o) => ({ ...o })), poisonFrom: a.poison };
  });
  const readP = () => {
    if (!p) return undefined;
    const pk = m.peek(p.a.block.addr + p.from, p.len);
    return { arena: p.a.name, from: p.from, len: p.len, text: String.fromCharCode(...pk.bytes) };
  };
  const step = (line: number, caption: string, extra: Partial<ScratchStep> = {}) => steps.push({ line, caption, arenas: view(), p: readP(), ...extra });
  const begin = (conflict: Arena | null) => {
    const a = ar.find((x) => x !== conflict) ?? ar[0]!;
    a.marks.push(a.pos);
    return a;
  };
  const end = (a: Arena) => {
    a.pos = a.marks.pop()!;
    a.owners = a.owners.filter((o) => o.to <= a.pos);
    if (opts.poison) a.poison = a.pos;
  };
  const put = (a: Arena, text: string, label: string) => {
    const from = a.pos;
    m.store({ addr: a.block.addr + from, alloc: a.block.alloc }, array(T.char, text.length), [...text].map((c) => c.charCodeAt(0)));
    a.pos += text.length;
    a.owners.push({ from, to: a.pos, label });
    if (a.poison !== null) a.poison = Math.max(a.poison, a.pos);
    return from;
  };

  step(8, `caller starts. ${opts.arenas === 1 ? "The thread has one scratch arena, A, at position 0." : "The thread has two scratch arenas, A and B, both at position 0."}`);
  const outer = begin(null);
  step(9, `scratch_begin(NULL) returns ${outer.name} and saves its mark: ${outer.pos}.`);
  const inner = begin(outer);
  step(2, inner === outer
    ? `join_path asks for a scratch arena that is not ${outer.name}. There is none, so it gets ${outer.name} again. Mark ${inner.pos}.`
    : `join_path asks for a scratch arena that is not ${outer.name}, and gets ${inner.name}. Mark ${inner.pos}.`);
  put(inner, "LOG", "up");
  step(3, `str_upper writes "LOG" in ${inner.name} at offset ${inner.pos - 3}.`);
  const rFrom = put(outer, "/tmp/LOG", "r");
  step(4, `str_cat writes the result "/tmp/LOG" in ${outer.name} (out) at offset ${rFrom}.`);
  end(inner);
  p = { a: outer, from: rFrom, len: 8 };
  const lost = rFrom >= inner.pos && inner === outer;
  step(5, lost
    ? `scratch_end puts ${inner.name}.pos back to ${inner.pos}. The result is past the mark: it is free memory now, but r still points at it.`
    : `scratch_end puts ${inner.name}.pos back to ${inner.pos}. Only "LOG" is free again. The result in ${outer.name} is safe.`, { bad: lost });
  step(10, `caller gets p = { ${hex(outer.block.addr + rFrom)}, 8 }.`, { bad: lost });
  put(outer, "OVERWRITE", "q");
  step(11, lost
    ? `str_upper writes "OVERWRITE" at offset ${outer.pos - 9} of ${outer.name}: the same bytes as p.`
    : `str_upper writes "OVERWRITE" after p, at offset ${outer.pos - 9}.`, { bad: lost });
  const read = readP()!;
  const poisoned = opts.poison && lost;
  step(12, poisoned
    ? `print(p) reads poisoned bytes. ASan stops the program here.`
    : lost ? `print(p) prints "${read.text}", not "/tmp/LOG". No tool reports it: the bytes are inside a live block.` : `print(p) prints "${read.text}".`,
  { bad: lost, report: poisoned ? `AddressSanitizer: use-after-poison on address ${hex(outer.block.addr + rFrom)}\nREAD of size 8` : undefined });
  end(outer);
  step(13, `scratch_end(s) puts ${outer.name}.pos back to 0. All temporary data of the call is gone in one step.`);
  return steps;
}

// ---------------------------------------------------------------- cost model

/** MODEL INPUTS (ns). */
export const COST = { malloc: 20, free: 15, bump: 2, reset: 50, copyPerByte: 0.1 } as const;

export interface CostOpts { n: number; size: number; survive: number }

/** ns per request with malloc and free for every object. */
export const mallocCost = (o: CostOpts) => o.n * (COST.malloc + COST.free);
/** ns per request with an arena: bumps, one reset, and a malloc'd copy (freed later) for each survivor. */
export const arenaCost = (o: CostOpts) => o.n * COST.bump + COST.reset + o.survive * o.n * (COST.malloc + COST.free + COST.copyPerByte * o.size);
/** The survivor fraction where both cost the same. Above it malloc wins. Can be above 1 (the arena always wins). */
export const breakEven = (n: number, size: number) => (n * (COST.malloc + COST.free - COST.bump) - COST.reset) / (n * (COST.malloc + COST.free + COST.copyPerByte * size));
