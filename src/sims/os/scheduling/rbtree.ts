/**
 * A red-black tree with a cached leftmost node, like the kernel's rb_root_cached (lib/rbtree.c).
 * CFS keeps its waiting tasks in one of these, ordered by vruntime.
 *
 * The rules: (1) a red node has no red child, (2) every path from the root to a null has the same number
 * of black nodes. Together they keep the height at most 2 * log2(n + 1).
 */
export type RbColor = "red" | "black";

export interface RbNode<T> { value: T; color: RbColor; left: RbNode<T> | null; right: RbNode<T> | null; parent: RbNode<T> | null }

export interface RbLayoutNode<T> { value: T; color: RbColor; x: number; depth: number; parentX: number | null; parentDepth: number | null }

export class RbTree<T> {
  root: RbNode<T> | null = null;
  size = 0;
  private leftmost: RbNode<T> | null = null;

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  /** The smallest value, in O(1). This is what __pick_first_entity reads. */
  min(): T | null { return this.leftmost?.value ?? null; }

  insert(value: T): RbNode<T> {
    const n: RbNode<T> = { value, color: "red", left: null, right: null, parent: null };
    let p: RbNode<T> | null = null, cur = this.root, isLeftmost = true;
    while (cur) {
      p = cur;
      if (this.less(value, cur.value)) cur = cur.left;
      else { cur = cur.right; isLeftmost = false; }
    }
    n.parent = p;
    if (!p) this.root = n;
    else if (this.less(value, p.value)) p.left = n;
    else p.right = n;
    if (isLeftmost) this.leftmost = n;
    this.size++;
    this.fixInsert(n);
    return n;
  }

  private rotate(x: RbNode<T>, dir: "left" | "right"): void {
    const other = dir === "left" ? "right" : "left";
    const y = x[other]!;
    x[other] = y[dir];
    if (y[dir]) y[dir]!.parent = x;
    y.parent = x.parent;
    if (!x.parent) this.root = y;
    else if (x === x.parent.left) x.parent.left = y;
    else x.parent.right = y;
    y[dir] = x;
    x.parent = y;
  }

  private fixInsert(start: RbNode<T>): void {
    let z = start;
    while (z.parent && z.parent.color === "red") {
      const p = z.parent, g = p.parent!;
      const side = p === g.left ? "left" : "right";
      const other = side === "left" ? "right" : "left";
      const uncle = g[other];
      if (uncle && uncle.color === "red") {
        p.color = "black"; uncle.color = "black"; g.color = "red";
        z = g;
      } else {
        if (z === p[other]) { z = p; this.rotate(z, side); }
        z.parent!.color = "black";
        g.color = "red";
        this.rotate(g, other);
      }
    }
    this.root!.color = "black";
  }

  /** Finds the node that holds a value, by identity, using the order to walk down. */
  find(value: T): RbNode<T> | null {
    let cur = this.root;
    while (cur) {
      if (cur.value === value) return cur;
      cur = this.less(value, cur.value) ? cur.left : cur.right;
    }
    return null;
  }

  private transplant(u: RbNode<T>, v: RbNode<T> | null): void {
    if (!u.parent) this.root = v;
    else if (u === u.parent.left) u.parent.left = v;
    else u.parent.right = v;
    if (v) v.parent = u.parent;
  }

  /** Removes a value. Returns false if it is not in the tree. */
  remove(value: T): boolean {
    const z = this.find(value);
    if (!z) return false;
    if (z === this.leftmost) {
      let next: RbNode<T> | null;
      if (z.right) { next = z.right; while (next.left) next = next.left; }
      else next = z.parent;
      this.leftmost = next;
    }
    let removed = z.color;
    let x: RbNode<T> | null, xp: RbNode<T> | null;
    if (!z.left) { x = z.right; xp = z.parent; this.transplant(z, z.right); }
    else if (!z.right) { x = z.left; xp = z.parent; this.transplant(z, z.left); }
    else {
      let y = z.right;
      while (y.left) y = y.left;
      removed = y.color;
      x = y.right;
      if (y.parent === z) xp = y;
      else {
        xp = y.parent;
        this.transplant(y, y.right);
        y.right = z.right;
        y.right.parent = y;
      }
      this.transplant(z, y);
      y.left = z.left;
      y.left.parent = y;
      y.color = z.color;
    }
    this.size--;
    if (removed === "black") this.fixRemove(x, xp);
    return true;
  }

  private fixRemove(start: RbNode<T> | null, startParent: RbNode<T> | null): void {
    let x = start, p = startParent;
    while (x !== this.root && (!x || x.color === "black")) {
      const side = x === p!.left ? "left" : "right";
      const other = side === "left" ? "right" : "left";
      let w = p![other]!;
      if (w.color === "red") {
        w.color = "black"; p!.color = "red";
        this.rotate(p!, side);
        w = p![other]!;
      }
      const near = w[side], far = w[other];
      if ((!near || near.color === "black") && (!far || far.color === "black")) {
        w.color = "red";
        x = p;
        p = x!.parent;
      } else {
        if (!far || far.color === "black") {
          near!.color = "black"; w.color = "red";
          this.rotate(w, other);
          w = p![other]!;
        }
        w.color = p!.color;
        p!.color = "black";
        w[other]!.color = "black";
        this.rotate(p!, side);
        x = this.root;
        p = null;
      }
    }
    if (x) x.color = "black";
  }

  inorder(): T[] {
    const out: T[] = [];
    const walk = (n: RbNode<T> | null) => { if (n) { walk(n.left); out.push(n.value); walk(n.right); } };
    walk(this.root);
    return out;
  }

  height(): number {
    const h = (n: RbNode<T> | null): number => (n ? 1 + Math.max(h(n.left), h(n.right)) : 0);
    return h(this.root);
  }

  /** Layout for drawing: each node has its in-order position and depth, plus its parent's position. */
  layout(): RbLayoutNode<T>[] {
    const out: RbLayoutNode<T>[] = [];
    let i = 0;
    const walk = (n: RbNode<T> | null, depth: number): RbLayoutNode<T> | null => {
      if (!n) return null;
      const left = walk(n.left, depth + 1);
      const me: RbLayoutNode<T> = { value: n.value, color: n.color, x: i++, depth, parentX: null, parentDepth: null };
      out.push(me);
      const right = walk(n.right, depth + 1);
      for (const c of [left, right]) if (c) { c.parentX = me.x; c.parentDepth = depth; }
      return me;
    };
    walk(this.root, 0);
    return out;
  }

  /** Checks the red-black rules and the order. Returns the problems. An empty list means the tree is valid. */
  problems(): string[] {
    const out: string[] = [];
    if (this.root && this.root.color !== "black") out.push("root is red");
    const walk = (n: RbNode<T> | null): number => {
      if (!n) return 1;
      if (n.color === "red" && ((n.left && n.left.color === "red") || (n.right && n.right.color === "red"))) out.push("red node has a red child");
      if (n.left && n.left.parent !== n) out.push("bad parent link");
      if (n.right && n.right.parent !== n) out.push("bad parent link");
      const a = walk(n.left), b = walk(n.right);
      if (a !== b) out.push("black height differs");
      return a + (n.color === "black" ? 1 : 0);
    };
    walk(this.root);
    const seq = this.inorder();
    for (let i = 1; i < seq.length; i++) if (this.less(seq[i]!, seq[i - 1]!)) out.push("order is wrong");
    if (seq.length !== this.size) out.push("size is wrong");
    if ((seq[0] ?? null) !== this.min()) out.push("leftmost cache is stale");
    return out;
  }
}
