import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Demo, Stats, Param, select, range, useSim, cssVar } from "../kit";

const N = 8;
type Order = "ijk" | "ikj" | "tiled";
type Pt = [number, number, number]; // i, j, k

export function iterationOrder(kind: Order, tile = 4): Pt[] {
  const out: Pt[] = [];
  if (kind === "ijk") for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) out.push([i, j, k]);
  else if (kind === "ikj") for (let i = 0; i < N; i++) for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) out.push([i, j, k]);
  else
    for (let ii = 0; ii < N; ii += tile) for (let kk = 0; kk < N; kk += tile) for (let jj = 0; jj < N; jj += tile)
      for (let i = ii; i < ii + tile; i++) for (let k = kk; k < kk + tile; k++) for (let j = jj; j < jj + tile; j++) out.push([i, j, k]);
  return out;
}

/** Lines of 4 elements along a row (row-major), LRU cache holding `capacity` lines. */
export function cacheTrace(order: Pt[], capacity: number) {
  const lru: string[] = [];
  const steps: { lines: string[]; misses: number }[] = [];
  let misses = 0;
  for (const [i, j, k] of order) {
    for (const key of [`A${i}:${k >> 2}`, `B${k}:${j >> 2}`, `C${i}:${j >> 2}`]) {
      const at = lru.indexOf(key);
      if (at >= 0) lru.splice(at, 1);
      else { misses++; if (lru.length >= capacity) lru.shift(); }
      lru.push(key);
    }
    steps.push({ lines: [...lru], misses });
  }
  return steps;
}

function Cubes({ order, step }: { order: Pt[]; step: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const idx = useMemo(() => {
    const m = new Map<string, number>();
    order.forEach(([i, j, k], n) => m.set(`${i},${j},${k}`, n));
    return m;
  }, [order]);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const tmp = new THREE.Object3D();
    const faint = new THREE.Color(cssVar("--border") || "#ddd");
    const seen = new THREE.Color(cssVar("--c1") || "#2a5bd7");
    const cur = new THREE.Color(cssVar("--c4") || "#c9372c");
    let n = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
      tmp.position.set(j - (N - 1) / 2, (N - 1) / 2 - i, k - (N - 1) / 2);
      const visitedAt = idx.get(`${i},${j},${k}`)!;
      const isCur = visitedAt === step;
      tmp.scale.setScalar(isCur ? 0.9 : visitedAt < step ? 0.55 : 0.32);
      tmp.updateMatrix();
      mesh.setMatrixAt(n, tmp.matrix);
      mesh.setColorAt(n, isCur ? cur : visitedAt < step ? seen.clone().lerp(faint, Math.min(0.85, (step - visitedAt) / 120)) : faint);
      n++;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [step, idx]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, N * N * N]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial />
    </instancedMesh>
  );
}

function Grid({ label, cells, active }: { label: string; cells: Set<string>; active: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 2 }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${N}, 11px)`, gap: 1 }}>
        {Array.from({ length: N * N }, (_, n) => {
          const r = Math.floor(n / N), c = n % N;
          const key = `${r}:${c >> 2}`;
          const isActive = active === `${r}:${c}`;
          return <div key={n} style={{ width: 11, height: 11, borderRadius: 2, background: isActive ? "var(--c4)" : cells.has(key) ? "var(--c3)" : "var(--subtle)", border: "1px solid var(--border)" }} />;
        })}
      </div>
    </div>
  );
}

export function IterationSpaceDemo() {
  const [kind, setKind] = useState<Order>("ijk");
  const [capacity, setCapacity] = useState(8);
  const [speed, setSpeed] = useState(24);
  const order = useMemo(() => iterationOrder(kind), [kind]);
  const trace = useMemo(() => cacheTrace(order, capacity), [order, capacity]);
  const totals = useMemo(() => (["ijk", "ikj", "tiled"] as Order[]).map((o) => ({ o, m: cacheTrace(iterationOrder(o), capacity).at(-1)!.misses })), [capacity]);
  const step = useRef(0);
  const [, force] = useState(0);
  const sim = useSim({ dt: 1 / speed, autoplay: true, step: () => { step.current = (step.current + 1) % order.length; force((x) => x + 1); }, reset: () => { step.current = 0; } });
  useEffect(() => { step.current = 0; force((x) => x + 1); }, [kind, capacity]);
  const s = step.current;
  const [ci, cj, ck] = order[s]!;
  const lines = trace[s]!.lines;
  const of = (m: string) => new Set(lines.filter((l) => l.startsWith(m)).map((l) => l.slice(1)));
  return (
    <Demo
      title="C += A × B: the loop order is a path through a cube"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn ghost" onClick={sim.reset}>Restart</button></>}
      controls={
        <>
          <Param spec={select({ label: "Loop order", options: [{ value: "ijk", label: "i, j, k" }, { value: "ikj", label: "i, k, j" }, { value: "tiled", label: "tiled 4×4" }], default: "ijk", segmented: true })} value={kind} onChange={(v) => setKind(v as Order)} />
          <Param spec={select({ label: "Cache size (lines of 4)", options: ["4", "8", "16"].map((v) => ({ value: v, label: v })), default: "8", segmented: true })} value={String(capacity)} onChange={(v) => setCapacity(Number(v))} />
          <Param spec={range({ label: "Speed (steps per second)", min: 4, max: 120, step: 1, default: 24 })} value={speed} onChange={(v) => setSpeed(v as number)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(200px, 1fr)", gap: 16, alignItems: "center" }}>
        <div style={{ position: "relative", height: 300, borderRadius: 6, border: "1px solid var(--border)", background: "var(--subtle)" }}>
          <div className="muted" style={{ position: "absolute", left: 10, top: 8, fontSize: 11.5, zIndex: 1, pointerEvents: "none" }}>across: j · down: i · depth: k</div>
          <Canvas camera={{ position: [9, 7, 11], fov: 45 }} dpr={[1, 2]} fallback={<div className="empty">WebGL is not available in this browser.</div>}>
            <ambientLight intensity={0.7} />
            <directionalLight position={[10, 12, 8]} intensity={1.2} />
            <Cubes order={order} step={s} />
            <OrbitControls enablePan={false} enableZoom={false} autoRotate={!sim.running} autoRotateSpeed={0.6} />
          </Canvas>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <Stats items={[{ label: `step ${s + 1} / ${order.length}: (i, j, k)`, value: `(${ci}, ${cj}, ${ck})` }, { label: "cache misses so far", value: trace[s]!.misses }]} />
          <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
            <Grid label="A[i][k]" cells={of("A")} active={`${ci}:${ck}`} />
            <Grid label="B[k][j]" cells={of("B")} active={`${ck}:${cj}`} />
            <Grid label="C[i][j]" cells={of("C")} active={`${ci}:${cj}`} />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>Total misses: {totals.map((t) => `${t.o} ${t.m}`).join(" · ")}</div>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Red: the element in use now. Green: elements whose cache line is in the cache. Drag the cube to turn it.</p>
    </Demo>
  );
}
