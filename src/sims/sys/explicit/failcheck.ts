/**
 * `std.testing.checkAllAllocationFailures` (Zig 0.17.1, lib/std/testing.zig) on one small function, `loadUser`.
 *
 * The checker runs the test function once with no failure and counts its allocations (N). Then it runs it N more
 * times. In run k a `FailingAllocator` lets allocations 0..k-1 succeed and makes allocation k, and every later one,
 * return null. After each run:
 * - the function returned error.OutOfMemory, and allocated bytes != freed bytes: error.MemoryLeakDetected (it prints
 *   fail_index, allocated bytes, freed bytes, allocations, deallocations) and stops;
 * - the function succeeded although an allocation failed: error.SwallowedOutOfMemoryError;
 * - otherwise the next run.
 * Any error other than OutOfMemory goes back to the caller unchanged, so the checker never explores error paths that
 * are not allocation failures (here: error.InvalidEmail).
 *
 * The heap is the shared memory machine (src/sims/sys/mem), so each run ends with a LeakSanitizer-style leak check
 * and a snapshot for the HeapBlocks view. tests/unit/sys-explicit.test.ts compares all 16 flag combinations with
 * the output of the real checker (zig 0.17.1).
 */
import { Machine, type Ptr, type Snapshot } from "../mem";
import { growCapacity } from "./zigalloc";

export interface LoadFlags {
  /** `errdefer gpa.free(name);` */
  a: boolean;
  /** `errdefer gpa.free(email);` */
  b: boolean;
  /** `errdefer tags.deinit(gpa);` */
  c: boolean;
  /** `tags.append(gpa, "new") catch {};` instead of `try` */
  swallow: boolean;
}

export const LOAD_SOURCE = [
  "fn loadUser(gpa: Allocator, email_in: []const u8) !User {",
  "    const name = try gpa.dupe(u8, \"ada\");",
  "    errdefer gpa.free(name);",
  "    const email = try gpa.dupe(u8, email_in);",
  "    errdefer gpa.free(email);",
  "    var tags: std.ArrayList([]const u8) = .empty;",
  "    errdefer tags.deinit(gpa);",
  "    try tags.append(gpa, \"new\");",
  "    if (indexOfScalar(u8, email, '@') == null) return error.InvalidEmail;",
  "    return .{ .name = name, .email = email, .tags = tags };",
  "}",
];
/** Source lines (1-based) of the three errdefers, in the order a, b, c. */
export const ERRDEFER_LINES = { a: 3, b: 5, c: 7 } as const;

export const VALID_EMAIL = "ada@example.com";
export const BAD_EMAIL = "ada";
/** An ArrayList([]const u8) (16-byte items) asks for growCapacity(1) items at the first append. */
export const TAGS_BYTES = growCapacity(1, 16) * 16;

export type EventKind = "alloc" | "fail" | "free" | "skip" | "error" | "return";
export interface LoadEvent { line: number; kind: EventKind; text: string; what?: "name" | "email" | "tags" }

export interface LoadRun {
  /** null for the counting run and for a plain run. */
  failIndex: number | null;
  events: LoadEvent[];
  outcome: "ok" | "error.OutOfMemory" | "error.InvalidEmail";
  /** The failing allocator's counters. */
  allocatedBytes: number;
  freedBytes: number;
  allocations: number;
  deallocations: number;
  /** Blocks still live at the end of the run. */
  leaked: ("name" | "email" | "tags")[];
  induced: boolean;
  snapshot: Snapshot;
}

/** One run of testImpl: `var u = try loadUser(gpa, email); u.deinit(gpa);`. */
export function runLoad(flags: LoadFlags, failIndex: number | null, email = VALID_EMAIL): LoadRun {
  const m = new Machine();
  m.call("testImpl", []);
  const events: LoadEvent[] = [];
  let index = 0, induced = false, allocatedBytes = 0, freedBytes = 0, allocations = 0, deallocations = 0;
  const live = new Map<"name" | "email" | "tags", { p: Ptr; len: number }>();
  const alloc = (what: "name" | "email" | "tags", len: number, line: number): boolean => {
    if (failIndex !== null && index >= failIndex) {
      induced = true;
      events.push({ line, kind: "fail", text: `allocation ${index} of ${what} (${len} B) fails: null`, what });
      return false;
    }
    m.line = line;
    const p = m.malloc(len, 16, what);
    live.set(what, { p, len });
    allocatedBytes += len;
    allocations++;
    events.push({ line, kind: "alloc", text: `allocation ${index}: ${what}, ${len} B`, what });
    index++;
    return true;
  };
  const free = (what: "name" | "email" | "tags", line: number, why: string) => {
    const b = live.get(what);
    if (!b) return;
    m.line = line;
    m.free(b.p);
    live.delete(what);
    freedBytes += b.len;
    deallocations++;
    events.push({ line, kind: "free", text: `${why}: free ${what} (${b.len} B)`, what });
  };
  // errdefers registered so far: [line, flag, what]
  const errdefers: [number, boolean, "name" | "email" | "tags"][] = [];
  const fail = (line: number, err: LoadRun["outcome"]): LoadRun["outcome"] => {
    events.push({ line, kind: "error", text: `return ${err}` });
    for (const [l, on, what] of [...errdefers].reverse()) {
      if (on) free(what, l, "errdefer");
      else if (live.has(what)) events.push({ line: l, kind: "skip", text: `no errdefer: ${what} stays allocated`, what });
    }
    return err;
  };
  const body = (): LoadRun["outcome"] => {
    if (!alloc("name", 3, 2)) return fail(2, "error.OutOfMemory");
    errdefers.push([ERRDEFER_LINES.a, flags.a, "name"]);
    if (!alloc("email", email.length, 4)) return fail(4, "error.OutOfMemory");
    errdefers.push([ERRDEFER_LINES.b, flags.b, "email"]);
    errdefers.push([ERRDEFER_LINES.c, flags.c, "tags"]);
    if (!alloc("tags", TAGS_BYTES, 8)) {
      if (!flags.swallow) return fail(8, "error.OutOfMemory");
      events.push({ line: 8, kind: "skip", text: "catch {}: the error is swallowed, tags stays empty" });
    }
    if (!email.includes("@")) return fail(9, "error.InvalidEmail");
    events.push({ line: 10, kind: "return", text: "return the User: the caller owns name, email and tags" });
    return "ok";
  };
  const outcome = body();
  if (outcome === "ok") {
    // testImpl: u.deinit(gpa)
    for (const w of ["name", "email", "tags"] as const) free(w, 0, "u.deinit");
  }
  const leaked = [...live.keys()];
  m.line = 0;
  m.exit(0);
  return { failIndex, events, outcome, allocatedBytes, freedBytes, allocations, deallocations, leaked, induced, snapshot: m.snapshot() };
}

export interface CheckResult {
  /** The counting run, then one run per fail index. Runs after the one that stopped the checker are still listed. */
  runs: LoadRun[];
  needed: number;
  verdict: "pass" | "error.MemoryLeakDetected" | "error.SwallowedOutOfMemoryError";
  /** Index in `runs` of the run that stopped the checker, or -1. */
  stoppedAt: number;
  /** The checker's message, as it prints it (without the stack trace). */
  message: string[];
}

export function checkAll(flags: LoadFlags): CheckResult {
  const count = runLoad(flags, null);
  const needed = count.allocations;
  const runs = [count];
  for (let k = 0; k < needed; k++) runs.push(runLoad(flags, k));
  let verdict: CheckResult["verdict"] = "pass", stoppedAt = -1, message: string[] = [];
  for (let i = 1; i < runs.length; i++) {
    const r = runs[i]!;
    if (r.outcome === "ok") {
      verdict = r.induced ? "error.SwallowedOutOfMemoryError" : "pass";
      if (r.induced) { stoppedAt = i; message = ["error.SwallowedOutOfMemoryError"]; break; }
    } else if (r.allocatedBytes !== r.freedBytes) {
      verdict = "error.MemoryLeakDetected";
      stoppedAt = i;
      message = [
        `fail_index: ${r.failIndex}/${needed}`, `allocated bytes: ${r.allocatedBytes}`, `freed bytes: ${r.freedBytes}`,
        `allocations: ${r.allocations}`, `deallocations: ${r.deallocations}`,
      ];
      break;
    }
  }
  return { runs, needed, verdict, stoppedAt, message };
}
