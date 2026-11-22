/**
 * The object graphs that the gc lessons use, with positions for the graph views (unit coordinates).
 */
import { build, type Graph, type Pos } from "./heap";
import { rcInit, rcStore, type RcState } from "./rc";

export interface Preset { id: string; label: string; g: Graph; pos: Record<string, Pos> }

/** Reference counting presets: each object has two fields. */
export const RC_PRESETS: Preset[] = [
  {
    id: "list", label: "list",
    g: build({ A: ["B", null], B: ["C", null], C: [null, null] }, { r: "A" }),
    pos: { A: { x: 0.1, y: 0.5 }, B: { x: 0.5, y: 0.5 }, C: { x: 0.9, y: 0.5 } },
  },
  {
    id: "dag", label: "shared child",
    g: build({ A: ["B", "C"], B: ["D", null], C: ["D", null], D: [null, null] }, { r: "A" }),
    pos: { A: { x: 0.1, y: 0.5 }, B: { x: 0.5, y: 0.12 }, C: { x: 0.5, y: 0.88 }, D: { x: 0.9, y: 0.5 } },
  },
  {
    id: "dlist", label: "doubly linked",
    g: build({ A: ["B", null], B: ["C", "A"], C: [null, "B"] }, { r: "A" }),
    pos: { A: { x: 0.1, y: 0.5 }, B: { x: 0.5, y: 0.5 }, C: { x: 0.9, y: 0.5 } },
  },
  {
    id: "ring", label: "ring",
    g: build({ A: ["B", null], B: ["C", null], C: ["A", null] }, { r: "A" }),
    pos: { A: { x: 0.1, y: 0.5 }, B: { x: 0.7, y: 0.1 }, C: { x: 0.7, y: 0.9 } },
  },
];

/**
 * Trial deletion: A ⇄ B is a cycle that the root r still holds; C ⇄ D is a garbage cycle with an acyclic child E.
 * The roots t (to A) and s (to C) were just set to null, so A and C are the candidate roots.
 */
export function trialPreset(): { state: RcState; pos: Record<string, Pos> } {
  const g = build({ A: ["B", null], B: ["A", null], C: ["D", null], D: ["C", "E"], E: [null, null] }, { r: "A", t: "A", s: "C" });
  let s = rcInit(g);
  s = rcStore(s, { root: "t" }, null).state;
  s = rcStore(s, { root: "s" }, null).state;
  return {
    state: s,
    pos: { A: { x: 0.08, y: 0.25 }, B: { x: 0.08, y: 0.85 }, C: { x: 0.5, y: 0.25 }, D: { x: 0.5, y: 0.85 }, E: { x: 0.92, y: 0.85 } },
  };
}

/** Mark and sweep: live objects A–E (with a cycle E → A), garbage G1–G5 (with a cycle G3 ⇄ G4), mixed in memory. */
export const MS_GRAPH: Graph = build(
  { A: ["B", "C"], B: ["E", null], G1: ["G2", null], C: [null, null], G2: [null, null], G3: ["G4", null], D: ["C", null], G4: ["G3", null], G5: ["D", null], E: ["A", null] },
  { r: "A", s: "D" },
  { A: 32, B: 48, G1: 32, C: 64, G2: 32, G3: 48, D: 32, G4: 64, G5: 32, E: 48 },
);
export const MS_POS: Record<string, Pos> = {
  A: { x: 0.04, y: 0.15 }, B: { x: 0.36, y: 0.02 }, C: { x: 0.36, y: 0.5 }, E: { x: 0.68, y: 0.02 }, D: { x: 0.04, y: 0.6 },
  G1: { x: 0.68, y: 0.5 }, G2: { x: 0.96, y: 0.5 }, G3: { x: 0.36, y: 0.98 }, G4: { x: 0.68, y: 0.98 }, G5: { x: 0.04, y: 0.98 },
};

/** Cheney: shared child D (one forwarding pointer), a back edge D → A, and garbage G that points into the live set. */
export const CHENEY_GRAPH: Graph = build(
  { A: ["B", "C"], G: ["B", null], B: ["D", null], C: ["D", null], E: [null, null], D: ["A", null] },
  { r: "A", s: "E" },
  { A: 32, G: 32, B: 32, C: 48, E: 32, D: 32 },
);
export const CHENEY_POS: Record<string, Pos> = {
  A: { x: 0.05, y: 0.3 }, B: { x: 0.4, y: 0.05 }, C: { x: 0.4, y: 0.6 }, D: { x: 0.78, y: 0.3 }, E: { x: 0.05, y: 0.95 }, G: { x: 0.78, y: 0.95 },
};

/** Positions for the two concurrent-marking scenarios (A, B, C, D in both). */
export const CONC_POS: Record<string, Pos> = { A: { x: 0.08, y: 0.2 }, B: { x: 0.5, y: 0.2 }, C: { x: 0.92, y: 0.2 }, D: { x: 0.5, y: 0.9 } };
