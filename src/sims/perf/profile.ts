/**
 * A synthetic program as a call tree with true self-times and call counts, profiled two ways:
 * statistical sampling, and instrumentation (timing every call, which adds overhead per call).
 */
import { mulberry32 } from "../rng";

export interface Frame { name: string; selfMs: number; calls: number; children: Frame[] }

const f = (name: string, selfMs: number, calls: number, children: Frame[] = []): Frame => ({ name, selfMs, calls, children });

/** A request handler: JSON parsing, a database call, templating, logging, and a tiny hot hash function. */
export const PROGRAM: Frame = f("main", 2, 1, [
  f("handle_request", 8, 2000, [
    f("parse_json", 60, 2000, [f("utf8_validate", 25, 2000), f("alloc_string", 15, 60000)]),
    f("db_query", 10, 2000, [f("build_sql", 12, 2000), f("socket_read", 110, 6000), f("decode_rows", 40, 2000, [f("alloc_string", 20, 80000)])]),
    f("render_template", 45, 2000, [f("escape_html", 35, 50000), f("hash_key", 18, 600000)]),
    f("log_request", 9, 2000, [f("format_time", 6, 2000)]),
  ]),
  f("gc", 30, 40),
]);

export interface Flat { name: string; selfMs: number; calls: number }

/** Self time per function name (a function can appear under several parents). */
export function flatten(root: Frame): Flat[] {
  const m = new Map<string, Flat>();
  const walk = (x: Frame) => {
    const e = m.get(x.name) ?? { name: x.name, selfMs: 0, calls: 0 };
    e.selfMs += x.selfMs;
    e.calls += x.calls;
    m.set(x.name, e);
    x.children.forEach(walk);
  };
  walk(root);
  return [...m.values()].sort((a, b) => b.selfMs - a.selfMs);
}

export const totalMs = (x: Frame): number => x.selfMs + x.children.reduce((s, c) => s + totalMs(c), 0);

/** All root-to-frame stacks with their self time (the "collapsed stacks" a profiler produces). */
export function stacks(root: Frame): { stack: string[]; ms: number }[] {
  const out: { stack: string[]; ms: number }[] = [];
  const walk = (x: Frame, path: string[]) => {
    const p = [...path, x.name];
    if (x.selfMs > 0) out.push({ stack: p, ms: x.selfMs });
    x.children.forEach((c) => walk(c, p));
  };
  walk(root, []);
  return out;
}

/** Sampling: each sample lands in a stack with probability proportional to its time. */
export function sample(root: Frame, hz: number, seed = 1) {
  const st = stacks(root);
  const total = st.reduce((s, x) => s + x.ms, 0);
  const n = Math.max(1, Math.round((total / 1000) * hz));
  const r = mulberry32(seed);
  const cum: number[] = [];
  st.reduce((s, x, i) => ((cum[i] = s + x.ms), cum[i]!), 0);
  const counts = new Map<string, number>();
  for (let k = 0; k < n; k++) {
    const u = r() * total;
    const i = cum.findIndex((c) => c >= u);
    const leaf = st[i]!.stack.at(-1)!;
    counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
  }
  return { n, share: (name: string) => (counts.get(name) ?? 0) / n };
}

/** Instrumentation: every call pays `overheadNs` inside the measured function. */
export function instrument(root: Frame, overheadNs: number) {
  const flat = flatten(root);
  const inflated = flat.map((x) => ({ ...x, ms: x.selfMs + (x.calls * overheadNs) / 1e6 }));
  const total = inflated.reduce((s, x) => s + x.ms, 0);
  return { totalMs: total, share: (name: string) => (inflated.find((x) => x.name === name)?.ms ?? 0) / total };
}

// ---------------- flame graph layout ----------------

export interface FlameNode { name: string; value: number; children: FlameNode[] }

/** Merge stacks into a tree whose node values are inclusive time. Children sorted by name, as flame graphs do. */
export function flameTree(st: { stack: string[]; ms: number }[]): FlameNode {
  const root: FlameNode = { name: "all", value: 0, children: [] };
  for (const { stack, ms } of st) {
    root.value += ms;
    let cur = root;
    for (const name of stack) {
      let c = cur.children.find((x) => x.name === name);
      if (!c) cur.children.push((c = { name, value: 0, children: [] }));
      c.value += ms;
      cur = c;
    }
  }
  const sort = (n: FlameNode) => { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.children.forEach(sort); };
  sort(root);
  return root;
}
