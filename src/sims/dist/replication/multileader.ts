/**
 * Multi-leader replication on the shared Net: two leaders that accept writes during a partition and reconcile
 * after the heal, and the topologies that carry writes between many leaders.
 */
import { Net } from "../net";

// ============================================================================ two datacenters, one document

export type Field = "title" | "tags" | "likes";
export const FIELDS: Field[] = ["title", "tags", "likes"];
export type Value = string | string[] | number;

export interface MlOp {
  side: 0 | 1;
  field: Field;
  /** title: the new title. tags: the tag to add. likes: unused (+1). */
  value?: string;
  /** Real time of the write, ms. */
  at: number;
}

export type Resolver = "arrival" | "lww" | "merge" | "siblings";
export const RESOLVERS: Resolver[] = ["arrival", "lww", "merge", "siblings"];

export interface Version {
  value: Value;
  /** Version vector: writes by side 0 and side 1 to this field. */
  vv: [number, number];
  /** The writer's clock at the write, for last-write-wins. */
  ts: number;
  side: number;
  /** Real time of the write (the sim knows it; the replicas do not). */
  real: number;
}
export type Doc = Record<Field, Version[]>;

export const BASE_DOC = { title: "Draft", tags: [] as string[], likes: 0 };

export const DEFAULT_OPS: MlOp[] = [
  { side: 0, field: "title", value: "Plan A", at: 10 },
  { side: 1, field: "likes", at: 20 },
  { side: 0, field: "tags", value: "red", at: 30 },
  { side: 1, field: "title", value: "Plan B", at: 40 },
  { side: 0, field: "likes", at: 50 },
  { side: 1, field: "tags", value: "blue", at: 60 },
];

export type MlMsg = { k: "change"; field: Field; v: Version } | { k: "state"; fields: { field: Field; v: Version }[] };

export interface MlConfig {
  seed: number;
  resolver: Resolver;
  /** Clock offset of side 1, ms (side 0 has none). */
  skewMs: number;
  /** The partition starts before the first write and heals at this time (default: after the last write). */
  healAt?: number;
  latency: { min: number; max: number };
}

export interface MlResult {
  net: Net<MlMsg>;
  docs: [Doc, Doc];
  healAt: number;
  converged: boolean;
  /** Fields that both sides changed: the version vectors are concurrent. */
  conflicts: Field[];
  /** Writes whose effect is missing at a side after the heal. Title writes that a later write on the same side replaced do not count. */
  lost: { side: 0 | 1; op: MlOp }[];
  /** A title conflict that last-write-wins (or arrival order) settled for the write that came first in real time. */
  laterLost: number;
}

const dominates = (a: [number, number], b: [number, number]) => a[0] >= b[0] && a[1] >= b[1];
const lwwKey = (v: Version) => [v.ts, v.side] as const;
const newer = (a: Version, b: Version) => lwwKey(a)[0] > lwwKey(b)[0] || (lwwKey(a)[0] === lwwKey(b)[0] && a.side > b.side);

function merge(field: Field, a: Version, b: Version): Version {
  const vv: [number, number] = [Math.max(a.vv[0], b.vv[0]), Math.max(a.vv[1], b.vv[1])];
  const top = newer(a, b) ? a : b;
  if (field === "tags") return { ...top, vv, value: [...new Set([...(a.value as string[]), ...(b.value as string[])])].sort() };
  // A counter merges with its common ancestor: base + both deltas.
  if (field === "likes") return { ...top, vv, value: BASE_DOC.likes + ((a.value as number) - BASE_DOC.likes) + ((b.value as number) - BASE_DOC.likes) };
  return { ...top, vv }; // two titles cannot merge: fall back to last-write-wins
}

/** Applies a version that arrived from the other side, with the chosen resolver. */
function receive(doc: Doc, field: Field, r: Version, resolver: Resolver) {
  const local = doc[field];
  if (resolver === "arrival") {
    doc[field] = [r];
    return;
  }
  if (local.some((l) => dominates(l.vv, r.vv))) return;
  if (local.every((l) => dominates(r.vv, l.vv))) {
    doc[field] = [r];
    return;
  }
  if (resolver === "siblings") doc[field] = [...local.filter((l) => !dominates(r.vv, l.vv)), r].sort((a, b) => a.side - b.side);
  else if (resolver === "lww") doc[field] = [[...local, r].reduce((a, b) => (newer(a, b) ? a : b))];
  else doc[field] = [local.reduce((a, b) => merge(field, a, b), r)];
}

const baseDoc = (): Doc => ({
  title: [{ value: BASE_DOC.title, vv: [0, 0], ts: 0, side: -1, real: 0 }],
  tags: [{ value: BASE_DOC.tags, vv: [0, 0], ts: 0, side: -1, real: 0 }],
  likes: [{ value: BASE_DOC.likes, vv: [0, 0], ts: 0, side: -1, real: 0 }],
});

export function runMultiLeader(ops: MlOp[], cfg: MlConfig): MlResult {
  const docs: [Doc, Doc] = [baseDoc(), baseDoc()];
  const sorted = [...ops].sort((a, b) => a.at - b.at);
  const healAt = cfg.healAt ?? (sorted.length ? sorted[sorted.length - 1]!.at : 0) + 15;
  const net = new Net<MlMsg>(2, { seed: cfg.seed, latency: cfg.latency, fifo: true }, {
    onTimer(node, tag, n) {
      if (tag.startsWith("op:")) {
        const op = sorted[Number(tag.slice(3))]!;
        const doc = docs[node]!;
        const cur = doc[op.field][0]!;
        const value: Value = op.field === "title" ? op.value! : op.field === "tags" ? [...new Set([...(cur.value as string[]), op.value!])].sort() : (cur.value as number) + 1;
        const vv: [number, number] = [cur.vv[0], cur.vv[1]];
        vv[node] = vv[node]! + 1;
        const v: Version = { value, vv, ts: n.clock(node), side: node, real: n.now };
        doc[op.field] = [v];
        n.send(node, 1 - node, { k: "change", field: op.field, v });
      } else if (tag === "heal") {
        // Anti-entropy after the heal: each side sends the fields it changed.
        const fields = FIELDS.filter((f) => docs[node]![f].some((v) => v.vv[node]! > 0)).flatMap((f) => docs[node]![f].map((v) => ({ field: f, v })));
        n.send(node, 1 - node, { k: "state", fields });
      }
    },
    onMessage(node, msg) {
      const p = msg.payload;
      if (p.k === "change") receive(docs[node]!, p.field, p.v, cfg.resolver);
      else for (const x of p.fields) receive(docs[node]!, x.field, x.v, cfg.resolver);
    },
  });
  net.offset[1] = cfg.skewMs;
  net.partition([[0], [1]]);
  sorted.forEach((op, i) => net.setTimer(op.side, op.at, `op:${i}`));
  net.runUntil(healAt);
  net.heal();
  net.setTimer(0, 0, "heal");
  net.setTimer(1, 0, "heal");
  net.runAll();

  const show = (d: Doc) => JSON.stringify(FIELDS.map((f) => d[f].map((v) => v.value)));
  const converged = show(docs[0]) === show(docs[1]);
  const conflicts = FIELDS.filter((f) => sorted.some((o) => o.field === f && o.side === 0) && sorted.some((o) => o.field === f && o.side === 1));
  const lost: MlResult["lost"] = [];
  let laterLost = 0;
  for (const side of [0, 1] as const) {
    const d = docs[side];
    sorted.forEach((op, i) => {
      if (op.field === "title") {
        const lastOnSide = !sorted.slice(i + 1).some((o) => o.field === "title" && o.side === op.side);
        if (lastOnSide && !d.title.some((v) => v.value === op.value)) lost.push({ side, op });
      } else if (op.field === "tags") {
        if (!d.tags.some((v) => (v.value as string[]).includes(op.value!))) lost.push({ side, op });
      }
    });
    const likes = sorted.filter((o) => o.field === "likes");
    const have = d.likes.length > 1 ? likes.length : (d.likes[0]!.value as number) - BASE_DOC.likes;
    // The newest increments are the ones that went missing.
    for (const op of likes.slice(Math.max(0, have))) lost.push({ side, op });
  }
  if (conflicts.includes("title") && cfg.resolver !== "siblings") {
    const lastTitle = (s: 0 | 1) => [...sorted].reverse().find((o) => o.field === "title" && o.side === s)!;
    for (const side of [0, 1] as const) {
      const kept = docs[side].title[0]!;
      const loser = lastTitle(kept.side === 0 ? 1 : 0);
      if (kept.side >= 0 && loser.at > kept.real) laterLost++;
    }
    if (converged) laterLost = Math.min(1, laterLost);
  }
  return { net, docs, healAt, converged, conflicts, lost, laterLost };
}

/** The value of a field as text: one version, or siblings joined with " | ". */
export const fieldText = (vs: Version[]) =>
  vs.map((v) => (Array.isArray(v.value) ? `{${v.value.join(", ")}}` : String(v.value))).join(" | ");

// ============================================================================ topologies with four leaders

export type Topology = "all" | "ring" | "star";
export const LEADERS = ["A", "B", "C", "D"];

export type TopoMsg = { k: "op"; op: "insert" | "update"; origin: number };

export interface TopoConfig {
  seed: number;
  topology: Topology;
  /** Extra delay on the link from A to C (model input), ms. */
  slowMs: number;
  /** -1: nobody crashes. */
  crash: number;
  crashAt: number;
  /** Buffer an update until its insert has arrived (version vectors give this). */
  causal: boolean;
  latency: { min: number; max: number };
}

export const TOPO_DEFAULTS: TopoConfig = { seed: 4, topology: "all", slowMs: 25, crash: -1, crashAt: 14, causal: false, latency: { min: 5, max: 12 } };

export interface TopoResult {
  net: Net<TopoMsg>;
  /** Per node: the row it ends with. "new": insert, then update. "old": the update failed. "none": no insert. */
  rows: ("new" | "old" | "none")[];
  /** Nodes that received the update before the insert. */
  overtaken: number[];
  /** [node, op]: a live node that never received an op. */
  missed: [number, "insert" | "update"][];
  buffered: number;
}

/**
 * A inserts a row. B applies the insert and at once updates the row, so the update depends on the insert.
 * Each topology forwards the two operations to every leader in its own way.
 */
export function runTopology(cfg: TopoConfig): TopoResult {
  const N = 4;
  const got = Array.from({ length: N }, () => new Set<string>());
  const rows: TopoResult["rows"] = new Array(N).fill("none");
  const overtaken: number[] = [];
  const held: TopoMsg[][] = Array.from({ length: N }, () => []);
  let buffered = 0;
  const slowQ: TopoMsg[] = [];

  const link = (n: Net<TopoMsg>, from: number, to: number, p: TopoMsg) => {
    if (from === 0 && to === 2 && cfg.slowMs > 0) {
      slowQ.push(p);
      n.setTimer(0, cfg.slowMs, "slow");
    } else n.send(from, to, p);
  };
  /** Where a node sends an op that it created or received. */
  const targets = (node: number, origin: number): number[] => {
    if (cfg.topology === "all") return node === origin ? [0, 1, 2, 3].filter((x) => x !== node) : [];
    if (cfg.topology === "ring") {
      const next = (node + 1) % N;
      return next === origin ? [] : [next];
    }
    if (node === 0) return [1, 2, 3].filter((x) => x !== origin); // the hub
    return node === origin ? [0] : [];
  };
  const apply = (n: Net<TopoMsg>, node: number, p: TopoMsg) => {
    got[node]!.add(p.op);
    if (p.op === "insert") rows[node] = "old";
    else if (rows[node] === "old") rows[node] = "new";
    for (const t of targets(node, p.origin)) link(n, node, t, p);
    if (node === 1 && p.op === "insert") {
      const upd: TopoMsg = { k: "op", op: "update", origin: 1 };
      apply(n, 1, upd);
    }
  };
  const net = new Net<TopoMsg>(N, { seed: cfg.seed, latency: cfg.latency, fifo: true }, {
    onTimer(node, tag, n) {
      if (tag === "start") apply(n, 0, { k: "op", op: "insert", origin: 0 });
      else if (tag === "slow") n.send(0, 2, slowQ.shift()!);
      void node;
    },
    onMessage(node, msg, n) {
      const p = msg.payload;
      if (got[node]!.has(p.op)) return;
      if (p.op === "update" && !got[node]!.has("insert")) {
        if (cfg.causal) {
          held[node]!.push(p);
          buffered++;
          return;
        }
        overtaken.push(node);
      }
      apply(n, node, p);
      if (p.op === "insert") for (const h of held[node]!.splice(0)) apply(n, node, h);
    },
  });
  net.setTimer(0, 1, "start");
  if (cfg.crash >= 0) {
    net.runUntil(cfg.crashAt);
    net.crash(cfg.crash);
  }
  net.runAll();
  const missed: TopoResult["missed"] = [];
  for (let i = 0; i < N; i++) {
    if (i === cfg.crash) continue;
    for (const op of ["insert", "update"] as const) if (!got[i]!.has(op)) missed.push([i, op]);
  }
  return { net, rows, overtaken, missed, buffered };
}
