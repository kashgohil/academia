/** Memory reclamation schemes, written as generator fragments that ops delegate to with yield*. */
import { nodeName, type OpGen, type Ptr, type ThreadState, type Word, type World } from "./machine";

type Frag<T = void> = Generator<string, T, void>;

/** Load a root and, under hazard pointers, protect what it points to. */
export function* protect(w: World, t: ThreadState, root: string, slot: number): Frag<Word> {
  for (;;) {
    yield `load ${root}`;
    const h = w.load(root);
    if (w.opts.scheme !== "hazard" || h.ptr === 0) return h;
    yield `hazard[${slot}] = ${nodeName(h.ptr)}`;
    t.hazards[slot] = h.ptr;
    yield `re-check ${root} is still ${nodeName(h.ptr)}`;
    if (w.load(root).ptr === h.ptr) return h;
  }
}

export function clearHazards(t: ThreadState) {
  t.hazards = [0, 0];
}

export function* pin(w: World, t: ThreadState): Frag {
  if (w.opts.scheme !== "epoch") return;
  yield "load global epoch";
  const e = w.epoch;
  yield `announce: active in epoch ${e}`;
  t.active = true;
  t.epoch = e;
  // Anything this thread retired two or more epochs ago is now unreachable by everyone.
  for (let i = 0; i < 3; i++) {
    if (t.bags[i]!.length && t.bagEpoch[i]! <= e - 2) {
      for (const p of t.bags[i]!) w.free(p);
      t.bags[i] = [];
    }
  }
}

export function* unpin(w: World, t: ThreadState): Frag {
  if (w.opts.scheme !== "epoch") return;
  yield "announce: inactive";
  t.active = false;
}

function* scan(w: World, t: ThreadState): Frag {
  const protectedSet = new Set<Ptr>();
  for (const u of w.threads) {
    yield `scan hazard pointers of T${u.id}`;
    u.hazards.forEach((h) => h && protectedSet.add(h));
  }
  const keep = t.retired.filter((p) => protectedSet.has(p));
  const drop = t.retired.filter((p) => !protectedSet.has(p));
  if (drop.length) {
    yield `free ${drop.map(nodeName).join(", ")}`;
    drop.forEach((p) => w.free(p));
  }
  t.retired = keep;
}

function* tryAdvance(w: World): Frag {
  yield "load global epoch";
  const g = w.epoch;
  for (const u of w.threads) {
    yield `check T${u.id}'s epoch`;
    if (u.active && u.epoch !== g) return; // someone is still in an older epoch
  }
  yield `advance global epoch ${g} → ${g + 1}`;
  if (w.epoch === g) w.epoch = g + 1;
}

export function* retire(w: World, t: ThreadState, p: Ptr): Frag {
  switch (w.opts.scheme) {
    case "leak":
      w.nodes[p]!.state = "retired";
      return;
    case "immediate":
      yield `free ${nodeName(p)}`;
      w.free(p);
      return;
    case "hazard":
      w.nodes[p]!.state = "retired";
      t.retired.push(p);
      if (t.retired.length >= w.opts.threshold) yield* scan(w, t);
      return;
    case "epoch": {
      w.nodes[p]!.state = "retired";
      // Label the bag with the GLOBAL epoch, not this thread's local one: the global epoch can be
      // one ahead, and a reader pinned in it may still hold p. Freeing at label + 2 is then safe.
      const g = w.epoch;
      const i = g % 3;
      if (t.bagEpoch[i] !== g) {
        for (const q of t.bags[i]!) w.free(q); // stale bag from ≥ 3 epochs ago
        t.bags[i] = [];
        t.bagEpoch[i] = g;
      }
      t.bags[i]!.push(p);
      if (t.bags.reduce((n, b) => n + b.length, 0) >= w.opts.threshold) yield* tryAdvance(w);
      return;
    }
  }
}

export type { OpGen };
