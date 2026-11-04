/** A hard disk in 3D: a turning platter, a head that seeks, and the queue of requests waiting on the surface. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Demo, Stats, Param, range, useParams, useSim, cssVar, Legend } from "../../kit";
import { HDDS, hddRun, rotationMs, type HddPattern, type HddSched, type HddServed } from "../../sims/db/storage";
import { seg, StackBar, ms } from "./StorageUi";

const VARS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--fg", "--muted", "--faint", "--border", "--bg", "--subtle"] as const;
type Theme = Record<(typeof VARS)[number], string>;
const FALLBACK: Theme = { "--c1": "#2a5bd7", "--c2": "#e07b14", "--c3": "#1d9a5b", "--c4": "#c9372c", "--c5": "#7d4cdb", "--fg": "#16181d", "--muted": "#5f6672", "--faint": "#9aa1ab", "--border": "#e3e5e8", "--bg": "#ffffff", "--subtle": "#f6f7f8" };
const readTheme = (): Theme => Object.fromEntries(VARS.map((v) => [v, cssVar(v) || FALLBACK[v]])) as Theme;

function useTheme(): Theme {
  const [t, setT] = useState(readTheme);
  useEffect(() => {
    const update = () => setT(readTheme());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", update);
    return () => { mo.disconnect(); mq?.removeEventListener?.("change", update); };
  }, []);
  return t;
}

const DISK = HDDS["7200"];
const ROT = rotationMs(DISK);
const R_OUT = 1.9, R_IN = 0.7;
/** Radius of a cylinder position: 0 = outer edge, 1 = inner edge. */
const radius = (cyl: number) => R_OUT - (R_OUT - R_IN) * cyl;

interface Shared { t: number; run: HddServed[]; arrival: Float64Array }

/** Index of the request being served at disk time t. */
function currentIndex(run: HddServed[], t: number): number {
  let lo = 0, hi = run.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (run[m]!.start <= t) lo = m; else hi = m - 1; }
  return lo;
}

function headCyl(s: HddServed, t: number): number {
  if (t >= s.start + s.seek || s.seek === 0) return s.req.cyl;
  const f = (t - s.start) / s.seek;
  const e = f < 0.5 ? 2 * f * f : 1 - 2 * (1 - f) * (1 - f); // accelerate, then brake
  return s.fromCyl + (s.req.cyl - s.fromCyl) * e;
}

/** Moves the camera back on narrow canvases so the whole platter stays in view. */
function CameraFit() {
  const { camera, size } = useThree();
  useEffect(() => {
    const k = Math.max(1, 1.9 / (size.width / Math.max(1, size.height)));
    camera.position.set(0.5 * k, 2.9 * k, 3.3 * k);
    camera.lookAt(0, 0, 0);
  }, [camera, size.width, size.height]);
  return null;
}

function Scene({ shared, theme }: { shared: React.MutableRefObject<Shared>; theme: Theme }) {
  const platter = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const dots = useRef<THREE.InstancedMesh>(null);
  const MAXQ = 40;
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const cTarget = useMemo(() => new THREE.Color(), []);
  const cWait = useMemo(() => new THREE.Color(), []);
  useEffect(() => { cTarget.set(theme["--c1"]); cWait.set(theme["--c2"]); }, [theme, cTarget, cWait]);
  useFrame(() => {
    const { t, run, arrival } = shared.current;
    if (!run.length) return;
    const rotTurns = t / ROT;
    // Group rotation θ moves a sector at platter angle a to world angle a − θ; the head sits at world angle 0.
    if (platter.current) platter.current.rotation.y = (rotTurns % 1) * 2 * Math.PI;
    const k = currentIndex(run, t);
    const cur = run[k]!;
    if (head.current) head.current.position.x = radius(headCyl(cur, t));
    const mesh = dots.current;
    if (!mesh) return;
    let n = 0;
    // The request in service, then the ones that have arrived and wait.
    for (let m = k; m < Math.min(run.length, k + 400) && n < MAXQ; m++) {
      const s = run[m]!;
      if (m > k && arrival[s.req.id]! > t) continue;
      const r = radius(s.req.cyl);
      // Sector angle in the platter frame; the platter group adds the rotation.
      const a = s.req.angle * 2 * Math.PI;
      tmp.position.set(r * Math.cos(a), 0.07, r * Math.sin(a));
      tmp.scale.setScalar(m === k ? 1.5 : 1);
      tmp.updateMatrix();
      mesh.setMatrixAt(n, tmp.matrix);
      mesh.setColorAt(n, m === k ? cTarget : cWait);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  const tracks = [0.85, 1.1, 1.35, 1.6, 1.85];
  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[3, 6, 4]} intensity={1.2} />
      <group ref={platter}>
        <mesh position={[0, -0.03, 0]}>
          <cylinderGeometry args={[2, 2, 0.06, 96]} />
          <meshStandardMaterial color={theme["--faint"]} metalness={0.5} roughness={0.35} />
        </mesh>
        {tracks.map((r) => (
          <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
            <ringGeometry args={[r - 0.004, r + 0.004, 96]} />
            <meshBasicMaterial color={theme["--muted"]} transparent opacity={0.5} />
          </mesh>
        ))}
        {/* a wedge so the rotation is easy to see */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0]}>
          <ringGeometry args={[R_IN, 2, 24, 1, 0, 0.12]} />
          <meshBasicMaterial color={theme["--c5"]} transparent opacity={0.35} side={THREE.DoubleSide} />
        </mesh>
        <instancedMesh ref={dots} args={[undefined, undefined, MAXQ]}>
          <sphereGeometry args={[0.055, 14, 10]} />
          <meshStandardMaterial />
        </instancedMesh>
      </group>
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 0.12, 48]} />
        <meshStandardMaterial color={theme["--muted"]} metalness={0.6} roughness={0.4} />
      </mesh>
      {/* Linear actuator along +x: the head slides to the track radius. */}
      <group ref={head} position={[radius(0.3), 0, 0]}>
        <mesh position={[0, 0.1, 0]}>
          <boxGeometry args={[0.14, 0.05, 0.12]} />
          <meshStandardMaterial color={theme["--c4"]} />
        </mesh>
        <mesh position={[1.4, 0.13, 0]}>
          <boxGeometry args={[2.8, 0.03, 0.08]} />
          <meshStandardMaterial color={theme["--fg"]} metalness={0.3} roughness={0.5} />
        </mesh>
      </group>
      <CameraFit />
      <OrbitControls enablePan={false} enableZoom={false} minPolarAngle={0.25} maxPolarAngle={1.25} />
    </>
  );
}

export function Disk3DDemo() {
  const theme = useTheme();
  const p = useParams("platter", {
    qd: range({ label: "Requests in the queue", min: 1, max: 16, step: 1, default: 1 }),
    pattern: seg<HddPattern>("Access pattern", [["random", "Random"], ["nearby", "Within 2% of the disk"], ["sequential", "Sequential"]], "random"),
    sched: seg<HddSched>("Order", [["fifo", "Arrival order"], ["elevator", "Elevator"]], "fifo"),
    slow: seg("Slow motion", [["400", "400×"], ["100", "100×"]], "400"),
  });
  const v = p.values;
  const result = useMemo(() => hddRun(DISK, { n: 300, qd: v.qd, sched: v.sched, pattern: v.pattern, bytes: 4096, seed: 4 }), [v.qd, v.sched, v.pattern]);
  const arrival = useMemo(() => {
    const a = new Float64Array(result.served.length + v.qd + 1);
    // Closed loop: request j (j ≥ qd) arrives when request j − qd completes.
    const ends = result.served.map((s) => s.end).sort((x, y) => x - y);
    for (let j = 0; j < a.length; j++) a[j] = j < v.qd ? 0 : (ends[j - v.qd] ?? Infinity);
    return a;
  }, [result, v.qd]);
  const shared = useRef<Shared>({ t: 0, run: result.served, arrival });
  shared.current.run = result.served;
  shared.current.arrival = arrival;
  useEffect(() => { shared.current.t = 0; }, [result]);
  const [, force] = useState(0);
  const sim = useSim({
    dt: 1 / 60,
    autoplay: true,
    step: (dt) => {
      const s = shared.current;
      s.t += (dt * 1000) / Number(v.slow);
      if (s.t >= result.totalMs) s.t = 0;
      force((x) => x + 1);
    },
    reset: () => { shared.current.t = 0; },
  });
  const t = shared.current.t;
  const k = currentIndex(result.served, t);
  const cur = result.served[k]!;
  const phase = t < cur.start + cur.seek ? "Seeking" : t < cur.start + cur.seek + cur.rotate ? "Waiting for the sector" : "Reading";
  const recent = result.served.slice(Math.max(0, k - 11), k + 1);
  const maxT = Math.max(...result.served.map((s) => s.end - s.start));
  const COL = { seek: "var(--c4)", rotate: "var(--c2)", transfer: "var(--c3)" };
  return (
    <Demo
      title="A 7,200 rpm disk in slow motion"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn ghost" onClick={sim.reset}>Restart</button></>}
      controls={<>
        <Param spec={p.schema.qd} value={v.qd} onChange={(x) => p.set("qd", x as number)} />
        <Param spec={p.schema.pattern} value={v.pattern} onChange={(x) => p.set("pattern", x as HddPattern)} />
        <Param spec={p.schema.sched} value={v.sched} onChange={(x) => p.set("sched", x as HddSched)} />
        <Param spec={p.schema.slow} value={v.slow} onChange={(x) => p.set("slow", x as string)} />
      </>}
    >
      <div style={{ position: "relative", height: 300, borderRadius: 6, border: "1px solid var(--border)", background: "var(--subtle)" }}>
        <div style={{ position: "absolute", left: 10, top: 8, zIndex: 1, pointerEvents: "none", fontSize: 12.5 }}>
          <b>{phase}</b>
          <div className="muted" style={{ fontSize: 11.5 }}>request {k + 1} · disk time {ms(t)}</div>
        </div>
        <Canvas camera={{ position: [0.5, 2.9, 3.3], fov: 42 }} dpr={[1, 2]} fallback={<div className="empty">WebGL is not available in this browser.</div>}>
          <Scene shared={shared} theme={theme} />
        </Canvas>
      </div>
      <div style={{ margin: "8px 0" }}>
        <Legend items={[{ label: "sector being served", color: "var(--c1)" }, { label: "waiting requests", color: "var(--c2)" }, { label: "head", color: "var(--c4)" }]} />
      </div>
      <div className="muted" style={{ fontSize: 12, margin: "8px 0 4px" }}>The latest requests, newest at the bottom (bar length = time)</div>
      <div style={{ display: "grid", gap: 3 }}>
        {recent.map((s) => (
          <div key={s.req.id} style={{ width: `${Math.max(2, ((s.end - s.start) / maxT) * 100)}%` }}>
            <StackBar height={8} parts={[{ label: "seek", value: s.seek, color: COL.seek }, { label: "rotate", value: s.rotate, color: COL.rotate }, { label: "transfer", value: s.transfer, color: COL.transfer }]} />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 6 }}><Legend items={[{ label: "seek", color: COL.seek }, { label: "rotation", color: COL.rotate }, { label: "transfer", color: COL.transfer }]} /></div>
      <Stats items={[
        { label: "average seek", value: ms(result.avg.seek) },
        { label: "average rotation wait", value: ms(result.avg.rotate) },
        { label: "average transfer", value: ms(result.avg.transfer) },
        { label: "reads per second", value: Math.round(result.iops).toLocaleString("en-US") },
      ]} />
    </Demo>
  );
}
