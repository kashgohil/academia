/** Michael & Scott's lock-free queue (1996): a linked list with a dummy head node and a lagging tail. */
import { fmt, nodeName, World, type Op, type OpGen, type ThreadState } from "./machine";
import { clearHazards, pin, protect, retire, unpin } from "./reclaim";

export function* msQueue(w: World, t: ThreadState, op: Op): OpGen {
  const tg = w.opts.tags;
  yield* pin(w, t);
  if (op.kind === "enq") {
    yield `allocate a node for ${op.v}`;
    const n = w.alloc(op.v);
    if (!n) { yield* unpin(w, t); return null; }
    t.ptrs.n = n;
    for (;;) {
      const tl = yield* protect(w, t, "tail", 0);
      t.ptrs.tail = tl.ptr;
      yield `read ${nodeName(tl.ptr)}.next`;
      const next = w.read(tl.ptr, "next").next.ptr;
      t.ptrs.next = next;
      yield "re-check tail";
      if (w.load("tail").ptr !== tl.ptr) continue;
      if (next === 0) {
        yield `CAS ${nodeName(tl.ptr)}.next: null → ${nodeName(n)}`;
        if (w.casNext(tl.ptr, 0, n)) {
          w.nodes[n]!.state = "live";
          yield `swing tail: ${fmt(tl, tg)} → ${nodeName(n)}`;
          w.cas("tail", tl, n); // may fail if someone helped already: fine
          clearHazards(t);
          yield* unpin(w, t);
          return op.v;
        }
      } else {
        yield `help: swing lagging tail ${fmt(tl, tg)} → ${nodeName(next)}`;
        w.cas("tail", tl, next);
      }
    }
  }
  for (;;) {
    const h = yield* protect(w, t, "head", 0);
    t.ptrs.head = h.ptr;
    yield "load tail";
    const tl = w.load("tail");
    t.ptrs.tail = tl.ptr;
    yield `read ${nodeName(h.ptr)}.next`;
    const next = w.read(h.ptr, "next").next.ptr;
    t.ptrs.next = next;
    if (w.opts.scheme === "hazard" && next) {
      yield `hazard[1] = ${nodeName(next)}`;
      t.hazards[1] = next;
    }
    yield "re-check head";
    if (w.load("head").ptr !== h.ptr) continue;
    if (h.ptr === tl.ptr) {
      if (next === 0) { clearHazards(t); yield* unpin(w, t); return null; }
      yield `help: swing lagging tail ${fmt(tl, tg)} → ${nodeName(next)}`;
      w.cas("tail", tl, next);
      continue;
    }
    yield `read ${nodeName(next)}.value`;
    const v = w.read(next, "value").value;
    yield `CAS head: ${fmt(h, tg)} → ${nodeName(next)}`;
    if (w.cas("head", h, next)) {
      clearHazards(t);
      yield* retire(w, t, h.ptr); // the old dummy; next becomes the new dummy
      yield* unpin(w, t);
      return v;
    }
  }
}

export function checkQueue(w: World): string | null {
  let p = w.roots.head!.ptr;
  const tail = w.roots.tail!.ptr;
  const seen = new Set<number>();
  let sawTail = false;
  while (p) {
    if (seen.has(p)) return `the list loops back to ${nodeName(p)}`;
    seen.add(p);
    if (p === tail) sawTail = true;
    const n = w.nodes[p]!;
    if (n.state === "free") return `the queue reaches ${nodeName(p)}, which was freed`;
    p = n.next.ptr;
  }
  return sawTail ? null : "tail is not reachable from head";
}

export function queueContents(w: World): number[] {
  const out: number[] = [];
  let p = w.nodes[w.roots.head!.ptr]!.next.ptr; // skip the dummy
  for (let i = 0; p && i <= w.nodes.length; i++) {
    out.push(w.nodes[p]!.value);
    p = w.nodes[p]!.next.ptr;
  }
  return out;
}
