/**
 * Who must know about the allocator? A small call graph of a request handler. The learner marks the functions that
 * allocate; the model says which signatures must change in each style:
 * - Zig (explicit parameter): a function needs a `gpa: Allocator` parameter when it allocates itself or calls a
 *   function that needs one, because the caller must pass the allocator down. (A struct can also keep the
 *   allocator in a field; the model does not use that.)
 * - Odin (implicit context): no signature changes. Every function can allocate through `context.allocator`, and
 *   the caller can change it for a scope.
 * - C (global malloc): no signature changes, and no caller can choose another allocator for one call.
 * This is a counting model, not a compiler: it only walks the graph.
 */

export interface FnNode { id: string; x: number; y: number; calls: string[]; leaf: boolean }

/** Positions in unit coordinates, callers above callees. */
export const CALL_GRAPH: FnNode[] = [
  { id: "main", x: 0.5, y: 0, calls: ["handle"], leaf: false },
  { id: "handle", x: 0.5, y: 0.33, calls: ["parse", "route", "log"], leaf: false },
  { id: "parse", x: 0.12, y: 0.66, calls: ["split"], leaf: false },
  { id: "route", x: 0.55, y: 0.66, calls: ["query", "render"], leaf: false },
  { id: "log", x: 0.92, y: 0.66, calls: [], leaf: true },
  { id: "split", x: 0.12, y: 1, calls: [], leaf: true },
  { id: "query", x: 0.4, y: 1, calls: [], leaf: true },
  { id: "render", x: 0.7, y: 1, calls: [], leaf: true },
];

export type Style = "zig" | "odin" | "c";

export interface RippleResult {
  /** Functions that allocate, directly or through a callee. */
  reach: Set<string>;
  /** Functions whose signature gains a parameter. */
  changed: Set<string>;
  /** Functions where a caller can choose the allocator for this call. */
  choosable: Set<string>;
}

export function ripple(allocating: Set<string>, style: Style, graph: FnNode[] = CALL_GRAPH): RippleResult {
  const by = new Map(graph.map((n) => [n.id, n]));
  const memo = new Map<string, boolean>();
  const reaches = (id: string): boolean => {
    if (memo.has(id)) return memo.get(id)!;
    const n = by.get(id)!;
    const r = allocating.has(id) || n.calls.some(reaches);
    memo.set(id, r);
    return r;
  };
  const reach = new Set(graph.filter((n) => reaches(n.id)).map((n) => n.id));
  // main gets its allocator from nowhere: it creates it, so its own signature stays the same
  const changed = style === "zig" ? new Set([...reach].filter((id) => id !== "main")) : new Set<string>();
  const choosable = style === "c" ? new Set<string>() : new Set(graph.map((n) => n.id).filter((id) => id !== "main"));
  return { reach, changed, choosable };
}
