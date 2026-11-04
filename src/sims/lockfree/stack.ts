/** Treiber's lock-free stack (1986). */
import { fmt, nodeName, World, type Op, type OpGen, type ThreadState } from "./machine";
import { clearHazards, pin, protect, retire, unpin } from "./reclaim";

export function* treiber(w: World, t: ThreadState, op: Op): OpGen {
  const tg = w.opts.tags;
  yield* pin(w, t);
  if (op.kind === "push") {
    yield `allocate a node for ${op.v}`;
    const n = w.alloc(op.v);
    if (!n) { yield* unpin(w, t); return null; }
    t.ptrs.n = n;
    for (;;) {
      yield "load head";
      const h = w.load("head");
      t.ptrs.h = h.ptr;
      w.nodes[n]!.next = { ptr: h.ptr, tag: 0 }; // private: nobody can see n yet
      yield `CAS head: ${fmt(h, tg)} → ${nodeName(n)}`;
      if (w.cas("head", h, n)) {
        w.nodes[n]!.state = "live";
        yield* unpin(w, t);
        return op.v;
      }
    }
  }
  for (;;) {
    const h = yield* protect(w, t, "head", 0);
    t.ptrs.h = h.ptr;
    if (h.ptr === 0) { clearHazards(t); yield* unpin(w, t); return null; }
    yield `read ${nodeName(h.ptr)}.next`;
    const next = w.read(h.ptr, "next").next.ptr;
    t.ptrs.next = next;
    yield `read ${nodeName(h.ptr)}.value`;
    const v = w.read(h.ptr, "value").value;
    yield `CAS head: ${fmt(h, tg)} → ${nodeName(next)}`;
    if (w.cas("head", h, next)) {
      clearHazards(t);
      yield* retire(w, t, h.ptr);
      yield* unpin(w, t);
      return v;
    }
  }
}

/** Walks from head; returns a description of the first broken invariant. */
export function checkStack(w: World): string | null {
  let p = w.roots.head!.ptr;
  const seen = new Set<number>();
  while (p) {
    if (seen.has(p)) return `the list from head loops back to ${nodeName(p)}`;
    seen.add(p);
    const n = w.nodes[p]!;
    if (n.state === "free") return `head's list reaches ${nodeName(p)}, which was freed`;
    p = n.next.ptr;
  }
  return null;
}

export function stackContents(w: World): number[] {
  const out: number[] = [];
  let p = w.roots.head!.ptr;
  for (let i = 0; p && i <= w.nodes.length; i++) {
    out.push(w.nodes[p]!.value);
    p = w.nodes[p]!.next.ptr;
  }
  return out;
}
