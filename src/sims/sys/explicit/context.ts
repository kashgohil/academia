/**
 * Odin's implicit `context`, run on the shared memory machine (src/sims/sys/mem).
 *
 * Facts (odin-lang.org/docs/overview, "Implicit context system", and the FAQ): procedures with the default "odin"
 * calling convention get a pointer to the current context as an implicit extra argument. The `context` variable is
 * local to each scope: an assignment such as `context.allocator = x` changes it for the rest of that scope and for
 * the procedures called from it, and the caller's context does not change. The Context struct
 * (base/runtime/core.odin) holds allocator, temp_allocator, assertion_failure_proc, logger, random_generator,
 * user_ptr, user_index and `_internal`. An Allocator is two words: `procedure` and `data`.
 *
 * MODEL CHOICES, not facts about the Odin compiler: a scope that assigns to the context gets its own copy of the
 * Context struct in its stack frame, and its callees get a pointer to that copy (this gives the documented scope
 * rule). Logger and Random_Generator are shown as two words each (the real Logger has more fields). The runtime
 * entry is shown as a frame `_start` that holds the first context. The temp allocator is a growing arena; its first
 * block is 4 MiB (DEFAULT_TEMP_ALLOCATOR_BACKING_SIZE in base/runtime/default_temporary_allocator.odin), allocated
 * on first use. `free_all` keeps the first block and resets it. Allocation sizes: `make([dynamic]string, 0, 4)` is
 * 4 x 16 bytes, and `strings.join` of "hello" and "ada" with " " is 9 bytes.
 *
 * Odin is not installed here, so the program text in CONTEXT_SOURCE is unchecked.
 */
import { Machine, ptr, struct, T, hex, type Ptr, type Snapshot } from "../mem";

export type Override = "none" | "track" | "temp" | "both";

export const ALLOCATOR_T = struct("Allocator", [["procedure", ptr()], ["data", ptr()]]);
export const CONTEXT_T = struct("Context", [
  ["allocator", ALLOCATOR_T], ["temp_allocator", ALLOCATOR_T], ["assertion_failure_proc", ptr()],
  ["logger", struct("Logger", [["procedure", ptr()], ["data", ptr()]])],
  ["random_generator", struct("Random_Generator", [["procedure", ptr()], ["data", ptr()]])],
  ["user_ptr", ptr()], ["user_index", T.i64], ["_internal", ptr()],
]);
const TRACK_T = struct("Tracking_Allocator", [["backing", ALLOCATOR_T], ["allocation_map", ptr()], ["current_memory_allocated", T.i64]]);
const TEMP_T = struct("Default_Temp_Allocator", [["first_block", ptr()], ["offset", T.u64]]);

export const TEMP_BLOCK = 4 * 1024 * 1024;
export const PARTS_BYTES = 4 * 16;
export const PAGE_BYTES = "hello ada".length;

/** The Odin program. Lines with a tag appear only for some overrides. */
export const CONTEXT_SOURCE: { text: string; tag?: "track" | "temp" }[] = [
  { text: "main :: proc() {" },
  { text: "    track: mem.Tracking_Allocator", tag: "track" },
  { text: "    mem.tracking_allocator_init(&track, context.allocator)", tag: "track" },
  { text: "    context.allocator = mem.tracking_allocator(&track)", tag: "track" },
  { text: "    serve()" },
  { text: "    report_leaks(&track)", tag: "track" },
  { text: "}" },
  { text: "serve :: proc() {" },
  { text: "    context.allocator = context.temp_allocator", tag: "temp" },
  { text: "    page := render(\"ada\")" },
  { text: "    send(page) // no delete(page)" },
  { text: "    free_all(context.temp_allocator)", tag: "temp" },
  { text: "}" },
  { text: "render :: proc(name: string) -> string {" },
  { text: "    parts := make([dynamic]string, 0, 4)" },
  { text: "    defer delete(parts)" },
  { text: "    append(&parts, \"hello\", name)" },
  { text: "    return strings.join(parts[:], \" \")" },
  { text: "}" },
];

export type AllocName = "heap" | "tracking" | "temp";

export interface CtxFrameInfo {
  fn: string;
  /** The frame whose Context copy this frame uses. */
  uses: string;
  allocator: AllocName;
  ownCopy: boolean;
}

export interface CtxStep {
  /** 1-based line in CONTEXT_SOURCE, 0 for the runtime. */
  line: number;
  caption: string;
  snap: Snapshot;
  frames: CtxFrameInfo[];
  /** Text to show instead of the raw value of a stack slot, by slot id. */
  labels: Record<number, string>;
  /** Allocations that went through context.allocator in this step. */
  via?: AllocName;
  /** Live allocations in the temp arena (they are not machine blocks). */
  tempUsed: number;
  /** Report lines at the end. */
  report: string[];
}

interface Ctx { frame: string; alloc: AllocName; addr: number; slot: number }

/** Runs the program for one choice of overrides and records a step per line. */
export function runContext(ov: Override): CtxStep[] {
  const track = ov === "track" || ov === "both";
  const temp = ov === "temp" || ov === "both";
  const m = new Machine();
  const steps: CtxStep[] = [];
  const fnHeap = m.fnAddr("heap_allocator_proc"), fnTrack = m.fnAddr("tracking_allocator_proc"), fnTemp = m.fnAddr("arena_allocator_proc");
  const tempData = m.global("global_default_temp_allocator_data", TEMP_T);
  const procOf: Record<AllocName, number> = { heap: fnHeap, tracking: fnTrack, temp: fnTemp };
  // the context stack: the innermost scope's context last
  const ctxs: Ctx[] = [];
  const frameUses: { fn: string; ctx: Ctx; own: boolean }[] = [];
  const labels: Record<number, string> = {};
  let tempUsed = 0;
  let tempBlock: Ptr | null = null;
  const tracked = new Map<number, number>();
  const heapLive: { p: Ptr; what: string; via: AllocName }[] = [];
  let trackPtr: Ptr | null = null;

  const writeCtx = (at: Ptr, alloc: AllocName, dataPtr: Ptr | null) => {
    m.store(at, CONTEXT_T, {
      allocator: { procedure: { addr: procOf[alloc] }, data: dataPtr ?? null },
      temp_allocator: { procedure: { addr: fnTemp }, data: tempData },
      assertion_failure_proc: null, logger: { procedure: null, data: null }, random_generator: { procedure: null, data: null },
      user_ptr: null, user_index: 0, _internal: null,
    });
  };
  const top = () => ctxs[ctxs.length - 1]!;
  const step = (line: number, caption: string, via?: AllocName, report: string[] = []) => {
    steps.push({
      line, caption, snap: m.snapshot(), via, tempUsed, report,
      frames: frameUses.map((f) => ({ fn: f.fn, uses: f.ctx.frame, allocator: f.ctx.alloc, ownCopy: f.own })),
      labels: { ...labels },
    });
  };
  const call = (fn: string, extra: { name: string; type: typeof CONTEXT_T }[] = []) => {
    const c = top();
    m.call(fn, [{ name: "ctx (implicit)", type: ptr(CONTEXT_T), value: { addr: c.addr, alloc: c.slot } }, ...extra]);
    const slot = m.addrOf("ctx (implicit)");
    labels[slot.alloc!] = `→ ${c.frame}'s context`;
    frameUses.push({ fn, ctx: c, own: false });
  };
  const override = (alloc: AllocName, dataPtr: Ptr | null) => {
    const fn = frameUses[frameUses.length - 1]!.fn;
    const at = m.addrOf("context");
    writeCtx(at, alloc, dataPtr);
    const c: Ctx = { frame: fn, alloc, addr: at.addr, slot: at.alloc! };
    labels[at.alloc!] = `allocator = ${alloc}`;
    ctxs.push(c);
    frameUses[frameUses.length - 1] = { fn, ctx: c, own: true };
  };
  const ret = () => {
    const f = frameUses.pop()!;
    if (f.own) ctxs.pop();
    m.ret();
  };
  const allocate = (what: string, size: number, line: number) => {
    const via = top().alloc;
    if (via === "temp") {
      if (!tempBlock) {
        m.line = line;
        tempBlock = m.malloc(TEMP_BLOCK, 16, "temp arena block");
        m.store(m.field(tempData, TEMP_T, "first_block"), ptr(), tempBlock);
      }
      tempUsed += size;
      m.store(m.field(tempData, TEMP_T, "offset"), T.u64, tempUsed);
      return null;
    }
    m.line = line;
    const p = m.malloc(size, 16, what);
    heapLive.push({ p, what, via });
    if (via === "tracking") tracked.set(p.addr, size);
    return p;
  };
  const release = (p: Ptr | null) => {
    if (!p) return; // free on the temp arena does nothing
    m.free(p);
    tracked.delete(p.addr);
    const i = heapLive.findIndex((x) => x.p.addr === p.addr);
    if (i >= 0) heapLive.splice(i, 1);
  };

  // runtime start: the first context
  m.call("_start", [{ name: "context", type: CONTEXT_T }]);
  frameUses.push({ fn: "_start", ctx: { frame: "_start", alloc: "heap", addr: 0, slot: 0 }, own: true });
  {
    const at = m.addrOf("context");
    writeCtx(at, "heap", null);
    const c: Ctx = { frame: "_start", alloc: "heap", addr: at.addr, slot: at.alloc! };
    ctxs.push(c);
    frameUses[0] = { fn: "_start", ctx: c, own: true };
    labels[at.alloc!] = "allocator = heap";
  }
  step(0, "The runtime builds the first context: allocator is the heap allocator, temp_allocator is the temp arena.");
  const L = (n: number) => n;
  call("main", track ? [{ name: "track", type: TRACK_T }, { name: "context", type: CONTEXT_T }] : []);
  step(L(1), "main gets one hidden argument: a pointer to the runtime's context. Its signature does not show it.");
  if (track) {
    trackPtr = m.addrOf("track");
    m.store(trackPtr, TRACK_T, { backing: { procedure: { addr: fnHeap }, data: null }, allocation_map: null, current_memory_allocated: 0 });
    step(L(3), "tracking_allocator_init stores the current allocator (the heap) as the backing allocator.");
    override("tracking", trackPtr);
    step(L(4), "The assignment gives main its own copy of the context. The runtime's copy does not change.");
  }
  call("serve", temp ? [{ name: "context", type: CONTEXT_T }] : []);
  step(L(8), `serve gets a pointer to ${top().frame}'s context. Every call passes it on, with no parameter in the source.`);
  if (temp) {
    override("temp", tempData);
    step(L(9), "serve copies the context and points allocator at the temp arena. main's context still says tracking or heap.");
  }
  call("render");
  step(L(14), `render uses ${top().frame}'s context: allocator = ${top().alloc}. render cannot tell which one it gets.`);
  const parts = allocate("parts", PARTS_BYTES, 15);
  step(L(15), `make asks context.allocator (${top().alloc}) for ${PARTS_BYTES} bytes.`, top().alloc);
  step(L(17), "append fits in the capacity of 4: no new allocation.");
  allocate("page", PAGE_BYTES, 18);
  step(L(18), `strings.join asks context.allocator (${top().alloc}) for ${PAGE_BYTES} bytes and returns them.`, top().alloc);
  release(parts);
  step(L(16), top().alloc === "temp" ? "defer delete(parts): a free on the arena does nothing. The bytes stay until free_all." : "defer delete(parts) gives the 64 bytes back.");
  ret();
  step(L(10), "render returns. page points to bytes that the caller now owns.");
  step(L(11), "send(page). serve never deletes page.");
  if (temp) {
    tempUsed = 0;
    m.store(m.field(tempData, TEMP_T, "offset"), T.u64, 0);
    step(L(12), "free_all resets the temp arena. page now points at bytes the arena will hand out again.");
  }
  ret();
  if (temp) step(L(5), "serve returns, and its context copy dies with its frame. main's context is the current one again.");
  else step(L(5), "serve returns.");
  const report: string[] = [];
  if (track) {
    const leaks = [...tracked.values()];
    if (leaks.length) {
      report.push(`=== ${leaks.length} allocations not freed: ===`);
      for (const s of leaks) report.push(`- ${s} bytes @ main.odin(18:12)`);
    } else report.push("Tracking_Allocator: no allocations left.");
    step(L(6), "The tracking allocator lists what is still in its allocation_map.", undefined, report);
  }
  ret();
  m.exit(0);
  const lsan = m.ub.filter((u) => u.kind === "memory-leak").map((u) => u.note);
  step(L(7), lsan.length ? `At exit a leak checker finds ${lsan.length} unreachable block${lsan.length > 1 ? "s" : ""}.` : "The program exits. The temp arena block is still reachable from a global, so it is not a leak.", undefined, [...report, ...lsan]);
  void hex;
  return steps;
}
