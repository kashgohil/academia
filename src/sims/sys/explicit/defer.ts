/**
 * Cleanup that you can see: one function, `load`, acquires a buffer `a`, a file `f` and a buffer `c`, checks them,
 * and returns `a` and `c` to its caller. The file is closed on every path. The buffers are freed only on an error
 * path, because on success the caller owns them. The same function is written three ways:
 * - Zig: `errdefer` for a and c, `defer` for f. Rules (Zig language reference, "defer" and "errdefer"; checked with
 *   zig 0.17.1): a defer runs when control leaves its block, last registered first; an errdefer runs only when the
 *   function returns an error.
 * - C with goto: one label per resource, in reverse order of acquisition. Each failure jumps to the label that frees
 *   what exists so far.
 * - C with `__attribute__((cleanup(fn)))` (GCC and Clang): fn(&var) runs when var goes out of scope, last defined
 *   first. To hand a buffer to the caller, set the variable to NULL (the cleanup then frees NULL, which does nothing).
 *
 * Each run uses the shared memory machine (src/sims/sys/mem): the buffers are malloc blocks, the FILE is a heap
 * object (a model: glibc's fopen also allocates the FILE on the heap). The caller then reads `a` and `c` and frees
 * them. So the machine reports a use after free when a cleanup ran on the success path, a double free, and leaks at
 * exit.
 *
 * Also: a Go loop with `defer f.Close()` inside it. Go runs a deferred call when the surrounding FUNCTION returns
 * (Go spec, "Defer statements"), so every file stays open until the loop ends. Zig and Odin run a defer at the end of
 * the enclosing BLOCK, so each file closes at the end of its iteration.
 */
import { Machine, T, type Ptr, type Snapshot, type UbReport } from "../mem";

export type Lang = "zig" | "goto" | "cleanup";
export type FailAt = "none" | "a" | "f" | "c" | "check";
export type Bug = "none" | "zig-defer-c" | "zig-no-errdefer-a" | "goto-wrong-label" | "cleanup-no-steal";

export const FAIL_POINTS: { id: FailAt; label: string }[] = [
  { id: "none", label: "nothing fails" },
  { id: "a", label: "alloc a fails" },
  { id: "f", label: "open fails" },
  { id: "c", label: "alloc c fails" },
  { id: "check", label: "validate fails" },
];

export const BUGS: Record<Lang, { id: Bug; label: string }[]> = {
  zig: [{ id: "none", label: "correct" }, { id: "zig-defer-c", label: "defer, not errdefer, for c" }, { id: "zig-no-errdefer-a", label: "no errdefer for a" }],
  goto: [{ id: "none", label: "correct" }, { id: "goto-wrong-label", label: "c failure jumps to free_a" }],
  cleanup: [{ id: "none", label: "correct" }, { id: "cleanup-no-steal", label: "forget c = NULL" }],
};

export function deferSource(lang: Lang, bug: Bug): string[] {
  if (lang === "zig") return [
    "fn load(gpa: Allocator, path: []const u8) !Loaded {",
    "    const a = try gpa.alloc(u8, 64);",
    bug === "zig-no-errdefer-a" ? "    // (no errdefer for a)" : "    errdefer gpa.free(a);",
    "    const f = try openFile(path);",
    "    defer f.close();",
    "    const c = try gpa.alloc(u8, 32);",
    bug === "zig-defer-c" ? "    defer gpa.free(c);" : "    errdefer gpa.free(c);",
    "    try validate(f, a, c);",
    "    return .{ .a = a, .c = c };",
    "}",
  ];
  if (lang === "goto") return [
    "int load(const char *path, Loaded *out) {",
    "    char *a = malloc(64);",
    "    if (!a) goto fail;",
    "    FILE *f = fopen(path, \"r\");",
    "    if (!f) goto free_a;",
    "    char *c = malloc(32);",
    bug === "goto-wrong-label" ? "    if (!c) goto free_a;" : "    if (!c) goto close_f;",
    "    if (validate(f, a, c) != 0) goto free_c;",
    "    fclose(f);",
    "    out->a = a; out->c = c;",
    "    return 0;",
    "free_c:  free(c);",
    "close_f: fclose(f);",
    "free_a:  free(a);",
    "fail:    return -1;",
    "}",
  ];
  return [
    "int load(const char *path, Loaded *out) {",
    "    CLEANUP(free_p) char *a = malloc(64);",
    "    if (!a) return -1;",
    "    CLEANUP(close_p) FILE *f = fopen(path, \"r\");",
    "    if (!f) return -1;",
    "    CLEANUP(free_p) char *c = malloc(32);",
    "    if (!c) return -1;",
    "    if (validate(f, a, c) != 0) return -1;",
    "    out->a = a; a = NULL;",
    bug === "cleanup-no-steal" ? "    out->c = c;" : "    out->c = c; c = NULL;",
    "    return 0;",
    "}",
  ];
}

export interface Pending { label: string; kind: "defer" | "errdefer" | "cleanup"; line: number; key: "a" | "f" | "c" }

export interface DeferStep {
  line: number;
  caption: string;
  /** Pending cleanups, oldest first (the top of the stack is last). */
  pending: Pending[];
  /** Cleanups that ran in this step, in order. */
  ran?: string[];
  snap: Snapshot;
  ub: UbReport[];
  where: "load" | "caller" | "exit";
}

export interface DeferRun { steps: DeferStep[]; ok: boolean; ubKinds: string[]; leaked: string[] }

export function runDefer(lang: Lang, fail: FailAt, bug: Bug = "none"): DeferRun {
  const m = new Machine();
  const steps: DeferStep[] = [];
  let pending: Pending[] = [];
  let where: DeferStep["where"] = "caller";
  const step = (line: number, caption: string, ran?: string[]) => {
    const before = steps.length ? steps[steps.length - 1]!.snap.ub.length : 0;
    const snap = m.snapshot();
    steps.push({ line, caption, pending: pending.map((p) => ({ ...p })), ran, snap, ub: snap.ub.slice(before), where });
  };
  const res: Record<"a" | "f" | "c", Ptr | null> = { a: null, f: null, c: null };
  const acquire = (k: "a" | "f" | "c") => {
    m.line = 0;
    res[k] = k === "f" ? m.allocNamed("FILE", "f", { size: 216 }) : m.malloc(k === "a" ? 64 : 32, 16, k);
  };
  const release = (k: "a" | "f" | "c") => { m.free(res[k]); };
  const zig = lang === "zig";
  const L = (n: number) => n;
  m.call("caller", [{ name: "a", type: { k: "ptr", to: T.char } }, { name: "c", type: { k: "ptr", to: T.char } }]);
  step(0, "The caller calls load and will own a and c if load succeeds.");
  m.call("load", []);
  where = "load";

  // returns true when load succeeded
  const body = (): boolean => {
    const unwindZig = (line: number, err: boolean): string[] => {
      const ran: string[] = [];
      for (const p of [...pending].reverse()) {
        if (p.kind === "errdefer" && !err) continue;
        ran.push(p.label);
        release(p.key);
      }
      pending = [];
      void line;
      return ran;
    };
    const unwindCleanup = (): string[] => {
      const ran: string[] = [];
      for (const p of [...pending].reverse()) {
        const k = p.key;
        ran.push(res[k] ? p.label : `${p.label} (NULL: nothing)`);
        if (res[k]) release(k);
      }
      pending = [];
      return ran;
    };
    // a
    if (fail === "a") {
      if (zig) { step(L(2), "gpa.alloc returns error.OutOfMemory. try returns it at once. No cleanup is registered yet."); return false; }
      if (lang === "goto") { step(L(3), "malloc returns NULL: goto fail. Nothing to free."); step(L(15), "fail: return -1."); return false; }
      step(L(3), "malloc returns NULL, and return -1 runs the cleanup of a: free(NULL) does nothing.", unwindCleanup()); return false;
    }
    acquire("a");
    if (zig) {
      step(L(2), "a = 64 bytes from the allocator.");
      if (bug !== "zig-no-errdefer-a") { pending.push({ label: "gpa.free(a)", kind: "errdefer", line: 3, key: "a" }); step(L(3), "errdefer registers free(a). It runs only if load returns an error."); }
    } else if (lang === "goto") step(L(2), "a = malloc(64).");
    else { pending.push({ label: "free_p(&a)", kind: "cleanup", line: 2, key: "a" }); step(L(2), "a = malloc(64). free_p(&a) will run when a goes out of scope."); }
    // f
    if (fail === "f") {
      if (zig) { step(L(4), "openFile fails. try returns the error, and the pending cleanups run, newest first.", unwindZig(4, true)); return false; }
      if (lang === "goto") { step(L(5), "fopen returns NULL: goto free_a."); release("a"); step(L(14), "free_a: free(a)."); step(L(15), "fail: return -1."); return false; }
      step(L(5), "fopen returns NULL. return -1 runs the cleanups, newest first.", unwindCleanup()); return false;
    }
    acquire("f");
    if (zig) { step(L(4), "f = the open file."); pending.push({ label: "f.close()", kind: "defer", line: 5, key: "f" }); step(L(5), "defer registers f.close(). It runs on every exit."); }
    else if (lang === "goto") step(L(4), "f = fopen(...).");
    else { pending.push({ label: "close_p(&f)", kind: "cleanup", line: 4, key: "f" }); step(L(4), "f = fopen(...). close_p(&f) is registered."); }
    // c
    if (fail === "c") {
      if (zig) { step(L(6), "alloc of c fails. The pending cleanups run, newest first.", unwindZig(6, true)); return false; }
      if (lang === "goto") {
        if (bug === "goto-wrong-label") { step(L(7), "malloc returns NULL. The jump goes to free_a and skips close_f."); release("a"); step(L(14), "free_a: free(a). The FILE stays open."); step(L(15), "fail: return -1."); return false; }
        step(L(7), "malloc returns NULL: goto close_f."); release("f"); step(L(13), "close_f: fclose(f)."); release("a"); step(L(14), "free_a: free(a)."); step(L(15), "fail: return -1."); return false;
      }
      step(L(7), "malloc returns NULL. return -1 runs the cleanups, newest first.", unwindCleanup()); return false;
    }
    acquire("c");
    if (zig) {
      step(L(6), "c = 32 bytes.");
      pending.push({ label: "gpa.free(c)", kind: bug === "zig-defer-c" ? "defer" : "errdefer", line: 7, key: "c" });
      step(L(7), bug === "zig-defer-c" ? "defer registers free(c). It runs on every exit, success too." : "errdefer registers free(c).");
    } else if (lang === "goto") step(L(6), "c = malloc(32).");
    else { pending.push({ label: "free_p(&c)", kind: "cleanup", line: 6, key: "c" }); step(L(6), "c = malloc(32). free_p(&c) is registered."); }
    // check
    if (fail === "check") {
      if (zig) { step(L(8), "validate returns an error. Every pending cleanup runs, newest first.", unwindZig(8, true)); return false; }
      if (lang === "goto") { step(L(8), "validate fails: goto free_c."); release("c"); step(L(12), "free_c: free(c)."); release("f"); step(L(13), "close_f: fclose(f)."); release("a"); step(L(14), "free_a: free(a)."); step(L(15), "fail: return -1."); return false; }
      step(L(8), "validate fails. return -1 runs all three cleanups.", unwindCleanup()); return false;
    }
    // success
    if (zig) { step(L(9), "Success. Only the defers run; the errdefers are dropped.", unwindZig(9, false)); return true; }
    if (lang === "goto") { release("f"); step(L(9), "fclose(f): the success path closes the file by hand."); step(L(10), "a and c go to the caller."); step(L(11), "return 0."); return true; }
    res.a = null;
    step(L(9), "out->a = a, then a = NULL, so the cleanup of a will free NULL.");
    if (bug !== "cleanup-no-steal") res.c = null;
    step(L(10), bug === "cleanup-no-steal" ? "out->c = c, but c keeps its value." : "out->c = c, then c = NULL.");
    step(L(11), "return 0 runs the cleanups, newest first.", unwindCleanup());
    return true;
  };
  let aPtr: Ptr | null = null, cPtr: Ptr | null = null;
  const ok = body();
  // the returned pointers: the blocks that load made (the C cleanup version cleared its locals)
  const blocks = m.allAllocs().filter((x) => x.kind === "heap");
  const byName = (n: string) => blocks.find((x) => x.name === n);
  if (ok) {
    const a = byName("a"), c = byName("c");
    aPtr = a ? { addr: a.addr, alloc: a.id } : null;
    cPtr = c ? { addr: c.addr, alloc: c.id } : null;
  }
  m.ret();
  where = "caller";
  if (ok && aPtr && cPtr) {
    m.set("a", aPtr);
    m.set("c", cPtr);
    step(0, "load returned. The caller holds a and c.");
    m.store(aPtr, T.char, 65);
    m.store(cPtr, T.char, 67);
    step(0, "The caller writes a[0] and c[0].");
    m.free(aPtr);
    m.free(cPtr);
    step(0, "The caller frees a and c when it is done with them.");
  } else step(0, "load returned an error. The caller owns nothing.");
  where = "exit";
  m.exit(0);
  step(0, "The program exits. A leak checker looks for blocks that nobody freed.");
  const snap = m.snapshot();
  const leaked = snap.heap.filter((b) => b.state === "leaked").map((b) => b.objKind ? `${b.objKind} ${b.label}` : b.label);
  return { steps, ok, ubKinds: [...new Set(snap.ub.map((u) => u.kind))], leaked };
}

// ---------------------------------------------------------------- defer in a loop

export type LoopVariant = "go-loop" | "go-func" | "zig-block";

export const LOOP_SOURCE: Record<LoopVariant, { lang: "go" | "zig"; lines: string[] }> = {
  "go-loop": { lang: "go", lines: [
    "for _, name := range names {",
    "    f, err := os.Open(name)",
    "    if err != nil { return err }",
    "    defer f.Close() // runs when the function returns",
    "    process(f)",
    "}",
  ] },
  "go-func": { lang: "go", lines: [
    "for _, name := range names {",
    "    err := func() error {",
    "        f, err := os.Open(name)",
    "        if err != nil { return err }",
    "        defer f.Close() // runs when this literal returns",
    "        return process(f)",
    "    }()",
    "    if err != nil { return err }",
    "}",
  ] },
  "zig-block": { lang: "zig", lines: [
    "for (names) |name| {",
    "    const f = try dir.openFile(io, name, .{});",
    "    defer f.close(io); // runs at the end of this block",
    "    try process(f);",
    "}",
  ] },
};

/** Descriptors open before the loop: stdin, stdout and stderr. */
export const STD_FDS = 3;

export interface LoopRun {
  /** Open descriptors after each iteration (index i = after file i + 1). */
  open: number[];
  peak: number;
  /** Iteration (1-based) where open fails with EMFILE ("too many open files"), or null. */
  failedAt: number | null;
  /** Deferred calls waiting at the peak. */
  pendingAtPeak: number;
}

export function loopFds(files: number, limit: number, v: LoopVariant): LoopRun {
  const open: number[] = [];
  let cur = STD_FDS, peak = cur, failedAt: number | null = null, pending = 0, pendingAtPeak = 0;
  for (let i = 1; i <= files; i++) {
    if (cur + 1 > limit) { failedAt = i; break; }
    cur++;
    if (v === "go-loop") pending++;
    else cur--; // closed at the end of the iteration
    peak = Math.max(peak, v === "go-loop" ? cur : cur + 1);
    pendingAtPeak = Math.max(pendingAtPeak, pending);
    open.push(cur);
  }
  return { open, peak, failedAt, pendingAtPeak };
}
