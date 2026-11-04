/** The loss surface as a 3D mesh, with SGD, momentum and Adam rolling on it. Loaded lazily (three.js). */
import { useEffect, useMemo, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { contours } from "d3-contour";
import { Demo, Controls, Param, useParams, useSim, range, select, toggle, cssVar } from "../kit";
import { SURFACES, getSurface, type OptimizerId, type Surface, type Vec2 } from "../sims/optim";
import { heightMap, summarize, type RunSummary } from "../sims/flagshipextras";

const schema = {
  surface: select({ label: "Loss surface", options: SURFACES.map((s) => ({ value: s.id, label: s.label })), default: "bowl" }),
  lr: range({ label: "Learning rate η (SGD, momentum)", min: 0.005, max: 0.3, step: 0.005, default: 0.09, format: (v) => v.toFixed(3) }),
  adamLr: range({ label: "Learning rate (Adam)", min: 0.001, max: 1, default: 0.1, log: true }),
  beta: range({ label: "Momentum β", min: 0, max: 0.99, step: 0.01, default: 0.9 }),
  sgd: toggle({ label: "SGD", default: true }),
  momentum: toggle({ label: "Momentum", default: true }),
  adam: toggle({ label: "Adam", default: true }),
};

const STEPS = 400;
const TOL = 1e-6;
const N = 81; // grid points per side
const SIZE = 7; // world units across the longer side of the domain
const HEIGHT = 2.6; // world units from the lowest to the highest point
const LIFT = 0.05; // paths float this far above the surface
const OPTS: { id: OptimizerId; label: string; color: string }[] = [
  { id: "sgd", label: "SGD", color: "--c4" },
  { id: "momentum", label: "Momentum", color: "--c1" },
  { id: "adam", label: "Adam", color: "--c3" },
];

/** Changes value when the page theme changes, so colors read with cssVar are fresh. */
function useThemeKey() {
  const [key, setKey] = useState(() => document.documentElement.dataset.theme ?? "");
  useEffect(() => {
    const mo = new MutationObserver(() => setKey(document.documentElement.dataset.theme ?? ""));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return key;
}

/** Maps surface coordinates (x, y, normalized height) to world coordinates. */
function useWorld(s: Surface) {
  return useMemo(() => {
    const { x: [x0, x1], y: [y0, y1] } = s.domain;
    const sc = SIZE / Math.max(x1 - x0, y1 - y0);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const map = heightMap(s, N, N);
    const at = (x: number, y: number, h: number): [number, number, number] => [(x - cx) * sc, h * HEIGHT, -(y - cy) * sc];
    const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    return { map, at, inside };
  }, [s]);
}

function SurfaceMesh({ s, theme }: { s: Surface; theme: string }) {
  const { map, at } = useWorld(s);
  const geom = useMemo(() => {
    const { x: [x0, x1], y: [y0, y1] } = s.domain;
    const pos = new Float32Array(N * N * 3);
    const col = new Float32Array(N * N * 3);
    const low = new THREE.Color(cssVar("--c5") || "#7d4cdb").lerp(new THREE.Color(cssVar("--bg") || "#fff"), 0.15);
    const high = new THREE.Color(cssVar("--faint") || "#a2a7b0").lerp(new THREE.Color(cssVar("--bg") || "#fff"), 0.2);
    const c = new THREE.Color();
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const h = map.h[k]!;
        const p = at(x0 + (i / (N - 1)) * (x1 - x0), y0 + (j / (N - 1)) * (y1 - y0), h);
        pos.set(p, k * 3);
        c.copy(low).lerp(high, Math.pow(h, 0.8));
        col.set([c.r, c.g, c.b], k * 3);
      }
    const idx: number[] = [];
    for (let j = 0; j < N - 1; j++)
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i, b = a + 1, d = a + N, e = d + 1;
        idx.push(a, b, d, b, e, d); // counter-clockwise seen from above, so normals point up
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [s, map, at, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // Contour lines: a contour at height level L lies exactly on the surface at y = L · HEIGHT.
  const lines = useMemo(() => {
    const { x: [x0, x1], y: [y0, y1] } = s.domain;
    const levels = Array.from({ length: 14 }, (_, i) => (i + 0.5) / 14);
    const gens = contours().size([N, N]).thresholds(levels)(Array.from(map.h));
    const seg: number[] = [];
    const clampG = (g: number) => Math.min(N - 1, Math.max(0, g - 0.5));
    const onBorder = (a: number, b: number) => a === b && (a === 0 || a === N - 1);
    for (const c of gens) {
      const L = c.value;
      for (const poly of c.coordinates as number[][][][])
        for (const ring of poly)
          for (let q = 0; q + 1 < ring.length; q++) {
            const ga = clampG(ring[q]![0]!), ha = clampG(ring[q]![1]!);
            const gb = clampG(ring[q + 1]![0]!), hb = clampG(ring[q + 1]![1]!);
            if (onBorder(ga, gb) || onBorder(ha, hb)) continue; // d3-contour closes rings along the grid border
            const pa = at(x0 + (ga / (N - 1)) * (x1 - x0), y0 + (ha / (N - 1)) * (y1 - y0), L);
            const pb = at(x0 + (gb / (N - 1)) * (x1 - x0), y0 + (hb / (N - 1)) * (y1 - y0), L);
            seg.push(pa[0], pa[1] + 0.01, pa[2], pb[0], pb[1] + 0.01, pb[2]);
          }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seg), 3));
    return g;
  }, [s, map, at]);

  useEffect(() => () => geom.dispose(), [geom]);
  useEffect(() => () => lines.dispose(), [lines]);

  return (
    <>
      <mesh geometry={geom}>
        <meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.75} metalness={0.05} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      <lineSegments geometry={lines}>
        <lineBasicMaterial color={cssVar("--fg") || "#16181d"} transparent opacity={0.22} />
      </lineSegments>
    </>
  );
}

function Path({ s, run, k, color }: { s: Surface; run: RunSummary; k: number; color: string }) {
  const { map, at, inside } = useWorld(s);
  const { pts, head } = useMemo(() => {
    const onSurface = (x: number, y: number) => {
      const w = at(x, y, map.height(s.f(x, y)));
      return [w[0], w[1] + LIFT, w[2]] as [number, number, number];
    };
    const out: [number, number, number][] = [];
    let head: [number, number, number] | null = null;
    const shown = run.path.slice(0, k + 1);
    for (let i = 0; i < shown.length; i++) {
      const p = shown[i]!;
      if (!inside(p[0], p[1])) break; // a diverging path leaves the drawn area
      const q = shown[i - 1];
      if (q) {
        // Follow the surface between two iterates, so the line lies on the landscape.
        const a = onSurface(q[0], q[1]), b = onSurface(p[0], p[1]);
        const m = Math.min(16, Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.12)));
        for (let j = 1; j < m; j++) out.push(onSurface(q[0] + ((p[0] - q[0]) * j) / m, q[1] + ((p[1] - q[1]) * j) / m));
      }
      head = onSurface(p[0], p[1]);
      out.push(head);
    }
    return { pts: out, head };
  }, [run, k, map, at, inside, s]);
  if (!head) return null;
  return (
    <>
      {pts.length > 1 && <Line points={pts} color={color} lineWidth={2.5} />}
      <mesh position={[head[0], head[1] + 0.1, head[2]]}>
        <sphereGeometry args={[0.14, 24, 16]} />
        <meshStandardMaterial color={color} roughness={0.35} metalness={0.1} />
      </mesh>
    </>
  );
}

/** Moves the camera back on narrow screens, so the whole surface stays in view while it turns. */
function FitCamera({ s }: { s: Surface }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const { x: [x0, x1], y: [y0, y1] } = s.domain;
    const sc = SIZE / Math.max(x1 - x0, y1 - y0);
    // Half the diagonal of the surface must fit in the horizontal field of view while it turns.
    const halfDiag = (Math.hypot(x1 - x0, y1 - y0) * sc) / 2 + 0.3;
    const tanHalf = Math.tan(((40 / 2) * Math.PI) / 180);
    // The near corner is closer to the camera than the center, so add part of halfDiag for perspective.
    camera.position.setLength(Math.max(8, halfDiag * (1 / (tanHalf * aspect) + 0.6)));
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height, s]);
  return null;
}

function Markers({ s, start, theme }: { s: Surface; start: Vec2; theme: string }) {
  const { map, at } = useWorld(s);
  const fg = useMemo(() => cssVar("--fg") || "#16181d", [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = at(start[0], start[1], map.height(s.f(start[0], start[1])));
  return (
    <>
      {s.minima.map((m, i) => {
        const w = at(m[0], m[1], map.height(s.f(m[0], m[1])));
        return (
          <mesh key={i} position={[w[0], w[1] + 0.02, w[2]]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.1, 0.16, 32]} />
            <meshBasicMaterial color={fg} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
      <mesh position={[st[0], st[1] + 0.08, st[2]]}>
        <sphereGeometry args={[0.09, 16, 12]} />
        <meshBasicMaterial color={fg} />
      </mesh>
    </>
  );
}

const fmt = (v: number) => (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : v.toPrecision(3));

export function LossSurface3DDemo() {
  const params = useParams("gd3", schema);
  const v = params.values;
  const surf = getSurface(v.surface);
  const theme = useThemeKey();
  const [k, setK] = useState(0);
  const sim = useSim({ dt: 1 / 40, step: () => setK((x) => (x >= STEPS ? x : x + 1)) });
  useEffect(() => { if (k >= STEPS) sim.pause(); }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  const restart = () => { setK(0); sim.play(); };
  useEffect(restart, [v.surface, v.lr, v.adamLr, v.beta]); // eslint-disable-line react-hooks/exhaustive-deps

  const runs = useMemo(() => {
    const out: Partial<Record<OptimizerId, RunSummary>> = {};
    for (const o of OPTS) {
      if (!v[o.id]) continue;
      const lr = o.id === "adam" ? v.adamLr : v.lr;
      out[o.id] = summarize(surf, o.id, { lr, beta: o.id === "momentum" ? v.beta : 0.9 }, STEPS, surf.start, TOL);
    }
    return out;
  }, [surf, v.lr, v.adamLr, v.beta, v.sgd, v.momentum, v.adam]);

  const colors = useMemo(() => Object.fromEntries(OPTS.map((o) => [o.id, cssVar(o.color) || "#888"])) as Record<OptimizerId, string>, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Demo
      title="The same optimizers on the surface in 3D"
      actions={
        <>
          <button className="btn" onClick={k >= STEPS ? restart : sim.toggle}>{sim.running ? "Pause" : k >= STEPS ? "Replay" : "Play"}</button>
          <button className="btn ghost" onClick={() => { sim.pause(); setK(0); }}>Reset</button>
        </>
      }
      controls={
        <>
          <Controls params={params} only={["surface", "lr", "adamLr", "beta"]} />
          <div className="param">
            <span className="param-label">Show</span>
            <div className="row" style={{ gap: 14 }}>
              {OPTS.map((o) => (
                <Param key={o.id} spec={{ ...schema[o.id], label: o.label }} value={v[o.id]} onChange={(x) => params.set(o.id, x as boolean)} />
              ))}
            </div>
          </div>
        </>
      }
    >
      <div style={{ position: "relative", height: "min(340px, max(270px, 80vw))", borderRadius: 6, border: "1px solid var(--border)", background: "var(--subtle)", overflow: "hidden" }}>
        <div className="muted" style={{ position: "absolute", left: 10, top: 8, fontSize: 11.5, zIndex: 3, pointerEvents: "none" }}>
          Drag to turn · step {Math.min(k, STEPS)} / {STEPS}
        </div>
        <Canvas camera={{ position: [6.4, 5.4, 7.1], fov: 40 }} dpr={[1, 2]} fallback={<div className="empty">WebGL is not available in this browser.</div>}>
          <ambientLight intensity={0.55} />
          <hemisphereLight args={["#ffffff", "#444444", 0.5]} />
          <directionalLight position={[6, 10, 4]} intensity={1.3} />
          <group position={[0, -HEIGHT / 2 + 0.2, 0]}>
            <SurfaceMesh s={surf} theme={theme} />
            <Markers s={surf} start={surf.start} theme={theme} />
            {OPTS.map((o) => runs[o.id] && <Path key={o.id} s={surf} run={runs[o.id]!} k={k} color={colors[o.id]} />)}
          </group>
          <FitCamera s={surf} />
          <OrbitControls enablePan={false} enableZoom={false} autoRotate={!sim.running} autoRotateSpeed={0.5} />
        </Canvas>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 12 }}>
        {OPTS.filter((o) => runs[o.id]).map((o) => {
          const r = runs[o.id]!;
          const p = r.path[Math.min(k, r.path.length - 1)]!;
          const now = r.diverged && k >= r.path.length - 1 ? "diverged" : fmt(surf.f(p[0], p[1]));
          return (
            <div key={o.id} style={{ border: "1px solid var(--border)", borderLeft: `3px solid var(${o.color})`, borderRadius: 6, padding: "6px 10px", fontSize: 12.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{o.label}</div>
              <div className="muted">loss now: <b style={{ color: "var(--fg)", fontWeight: 550 }}>{now}</b></div>
              <div className="muted">loss after {STEPS} steps: <b style={{ color: "var(--fg)", fontWeight: 550 }}>{r.diverged ? "diverged" : fmt(r.finalLoss)}</b></div>
              <div className="muted">
                gap below 10⁻⁶ at step: <b style={{ color: "var(--fg)", fontWeight: 550 }}>{r.diverged ? "never" : r.stepsToConverge ?? `not in ${STEPS}`}</b>
              </div>
              {surf.minima.length > 1 && !r.diverged && (
                <div className="muted">ends near: <b style={{ color: "var(--fg)", fontWeight: 550 }}>({r.nearest[0].toFixed(2)}, {r.nearest[1].toFixed(2)})</b></div>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
        The height grows with the logarithm of the loss, so the deep valleys stay visible. The small dot is the start. Rings mark the minima. Red: SGD. Blue: momentum. Green: Adam.
      </p>
    </Demo>
  );
}
