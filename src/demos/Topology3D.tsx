/** A NUMA machine in 3D: sockets with cores, local memory, and the links between sockets. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Demo, Stats, Param, select, range, useParams, cssVar, useWidth, pct } from "../kit";
import { accessPath, numaFlows, CORES_PER_SOCKET, NUMA_DEFAULTS, PLACEMENT_LABEL, type Placement } from "../sims/multicoreextras";

// ---------------- theme ----------------

const VARS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--fg", "--muted", "--faint", "--border", "--bg", "--subtle"] as const;
type Theme = Record<(typeof VARS)[number], string>;
const FALLBACK: Theme = { "--c1": "#2a5bd7", "--c2": "#e07b14", "--c3": "#1d9a5b", "--c4": "#c9372c", "--c5": "#7d4cdb", "--fg": "#16181d", "--muted": "#5f6672", "--faint": "#9aa1ab", "--border": "#e3e5e8", "--bg": "#ffffff", "--subtle": "#f6f7f8" };

function readTheme(): Theme {
  return Object.fromEntries(VARS.map((v) => [v, cssVar(v) || FALLBACK[v]])) as Theme;
}

/** Theme colors for three.js; re-read when the page theme changes. */
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

const NODE_VAR = ["--c1", "--c3", "--c2", "--c5"] as const;
const NODE_CSS = NODE_VAR.map((v) => `var(${v})`);

// ---------------- layout ----------------

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const SP = 0.52; // core spacing

interface Layout {
  sockets: THREE.Vector3[];
  mem: THREE.Vector3[];
  mc: THREE.Vector3[];
  hub: THREE.Vector3[];
  side: number[];
  core: (s: number, c: number) => THREE.Vector3;
  link: (a: number, b: number) => THREE.QuadraticBezierCurve3;
  pairs: [number, number][];
}

function layout(s: number): Layout {
  const sockets = s === 2 ? [V(-2.3, 0, 0), V(2.3, 0, 0)] : [V(-2.3, 0, -2.0), V(2.3, 0, -2.0), V(-2.3, 0, 2.0), V(2.3, 0, 2.0)];
  const side = sockets.map((p) => Math.sign(p.x));
  const mem = sockets.map((p, i) => V(p.x + side[i]! * 2.05, 0.45, p.z));
  const mc = sockets.map((p, i) => V(p.x + side[i]! * 1.28, 0.32, p.z));
  const hub = sockets.map((p) => V(p.x, 0.6, p.z));
  const core = (si: number, c: number) => {
    const p = sockets[si]!;
    return V(p.x + ((c % 4) - 1.5) * SP, 0.42, p.z + (Math.floor(c / 4) - 1.5) * SP);
  };
  const pairs: [number, number][] = [];
  for (let a = 0; a < s; a++) for (let b = a + 1; b < s; b++) pairs.push([a, b]);
  const link = (a: number, b: number) => {
    const A = hub[a]!, B = hub[b]!;
    const diag = A.x !== B.x && A.z !== B.z;
    const vertical = A.x === B.x; // front-back pair on the same side
    const lift = diag ? (a + b === 3 && Math.min(a, b) === 0 ? 2.0 : 1.55) : vertical ? 0.8 : 1.1;
    const mid = A.clone().add(B).multiplyScalar(0.5).add(V(0, lift, 0));
    return new THREE.QuadraticBezierCurve3(A.clone(), mid, B.clone());
  };
  return { sockets, mem, mc, hub, side, core, link, pairs };
}

/** The path that data takes from memory node j to core c of socket i. */
function dataPath(L: Layout, j: number, i: number, c: number) {
  const p = new THREE.CurvePath<THREE.Vector3>();
  p.add(new THREE.LineCurve3(L.mem[j]!.clone().setY(0.95), L.mc[j]!.clone()));
  p.add(new THREE.LineCurve3(L.mc[j]!.clone(), L.hub[j]!.clone()));
  if (i !== j) p.add(L.link(j, i));
  p.add(new THREE.LineCurve3(L.hub[i]!.clone(), L.core(i, c).setY(0.56)));
  return p;
}

// ---------------- scene pieces ----------------

function CameraRig({ sockets }: { sockets: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  useEffect(() => {
    // Fit the whole machine: half-width 5.2 units, half-depth by socket count, seen from about 50° up.
    const aspect = size.width / Math.max(1, size.height);
    const tanV = Math.tan(((camera.fov ?? 40) * Math.PI) / 360), tanH = tanV * aspect;
    const d = Math.max((aspect < 1.4 ? 5.7 : 5.2) / tanH, (sockets === 2 ? 2.1 : 3.5) / tanV) * 1.18;
    camera.position.copy(V(0, 0.78, 0.63).normalize().multiplyScalar(d));
    camera.lookAt(0, 0.2, 0);
    camera.updateProjectionMatrix();
  }, [sockets, size.width, size.height, camera]);
  return null;
}

const labelStyle: CSSProperties = { position: "absolute", left: 0, top: 0, zIndex: 2, pointerEvents: "none", fontSize: 11, lineHeight: 1.2, whiteSpace: "nowrap", padding: "1px 6px", borderRadius: 4, background: "var(--bg)", borderWidth: 1, borderStyle: "solid", color: "var(--fg)", userSelect: "none", willChange: "transform" };

interface LabelDef { at: THREE.Vector3; text: string; color?: string }

/** Plain DOM labels: each frame, project the 3D anchors to the screen and move the label elements. */
function LabelProjector({ anchors, refs }: { anchors: THREE.Vector3[]; refs: { current: (HTMLDivElement | null)[] } }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    anchors.forEach((a, i) => {
      const el = refs.current[i];
      if (!el) return;
      v.copy(a).project(camera);
      const x = (v.x * 0.5 + 0.5) * size.width, y = (-v.y * 0.5 + 0.5) * size.height;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      el.style.visibility = v.z < 1 ? "visible" : "hidden";
    });
  });
  return null;
}

const isClick = (e: ThreeEvent<MouseEvent>) => (e.delta ?? 0) < 6;

interface Packet { curve: THREE.Curve<THREE.Vector3>; dur: number; phase: number; color: string; size: number; reverse?: "out" | "back" }

function Packets({ packets }: { packets: Packet[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const max = 640;
  const list = useMemo(() => packets.slice(0, max), [packets]);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const c = new THREE.Color();
    list.forEach((p, i) => m.setColorAt(i, c.set(p.color)));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.count = list.length;
  }, [list]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const time = clock.getElapsedTime();
    list.forEach((p, i) => {
      let u = (time / p.dur + p.phase) % 1;
      let scale = p.size;
      if (p.reverse === "out") { if (u >= 0.5) scale = 0; u = 1 - Math.min(1, u * 2); }
      else if (p.reverse === "back") { if (u < 0.5) scale = 0; u = Math.max(0, u * 2 - 1); }
      tmp.position.copy(p.curve.getPointAt(Math.min(1, Math.max(0, u))));
      tmp.scale.setScalar(scale);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, max]} frustumCulled={false}>
      <sphereGeometry args={[1, 12, 10]} />
      <meshStandardMaterial roughness={0.35} emissiveIntensity={0.25} />
    </instancedMesh>
  );
}

function Tube({ curve, radius, color, opacity = 1 }: { curve: THREE.Curve<THREE.Vector3>; radius: number; color: string; opacity?: number }) {
  const geo = useMemo(() => new THREE.TubeGeometry(curve, 48, radius, 8, false), [curve, radius]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} roughness={0.5} />
    </mesh>
  );
}

interface SceneProps {
  theme: Theme;
  sockets: number;
  mode: "one" | "program";
  from: number;
  node: number;
  core: number;
  active: Map<string, number>; // "socket:core" → thread
  linkUtil: Map<string, number>; // "a-b" → utilization 0..1 (worst direction)
  nodeUtil: number[];
  packets: Packet[];
  path: THREE.Curve<THREE.Vector3> | null;
  onCore: (s: number, c: number) => void;
  onNode: (j: number) => void;
}

function Scene({ theme, sockets, mode, from, node, core, active, linkUtil, nodeUtil, packets, path, onCore, onNode }: SceneProps) {
  const L = useMemo(() => layout(sockets), [sockets]);
  const col = (v: (typeof VARS)[number]) => theme[v];
  const nodeCol = (j: number) => theme[NODE_VAR[j]!];
  const mix = (a: string, b: string, t: number) => `#${new THREE.Color(a).lerp(new THREE.Color(b), Math.max(0, Math.min(1, t))).getHexString()}`;
  const linkCurves = useMemo(() => L.pairs.map(([a, b]) => ({ a, b, curve: L.link(a, b) })), [L]);
  const pointer = (on: boolean) => () => { if (mode === "one") document.body.style.cursor = on ? "pointer" : ""; };
  useEffect(() => () => { document.body.style.cursor = ""; }, []);
  return (
    <>
      <ambientLight intensity={0.75} />
      <directionalLight position={[6, 10, 7]} intensity={1.15} />
      <directionalLight position={[-6, 4, -5]} intensity={0.3} />
      <CameraRig sockets={sockets} />
      {L.sockets.map((p, s) => (
        <group key={s}>
          {/* the NUMA node: socket plus its memory, on one plate */}
          <mesh position={[p.x + L.side[s]! * 0.75, -0.08, p.z]}>
            <boxGeometry args={[4.1, 0.06, 2.6]} />
            <meshStandardMaterial color={nodeCol(s)} transparent opacity={0.16} />
          </mesh>
          <mesh position={[p.x, 0.12, p.z]}>
            <boxGeometry args={[2.3, 0.2, 2.3]} />
            <meshStandardMaterial color={mix(col("--border"), col("--fg"), 0.08)} roughness={0.8} />
          </mesh>
          {Array.from({ length: CORES_PER_SOCKET }, (_, c) => {
            const q = L.core(s, c);
            const picked = mode === "one" && s === from && c === core;
            const th = active.get(`${s}:${c}`);
            const color = picked ? col("--c4") : mode === "program" && th !== undefined ? nodeCol(s) : mode === "one" && s === from ? mix(col("--border"), nodeCol(s), 0.45) : mix(col("--border"), col("--muted"), 0.25);
            return (
              <mesh key={c} position={[q.x, picked ? 0.36 : 0.31, q.z]} onClick={(e) => { if (mode === "one" && isClick(e)) { e.stopPropagation(); onCore(s, c); } }} onPointerOver={pointer(true)} onPointerOut={pointer(false)}>
                <boxGeometry args={[0.4, picked ? 0.3 : 0.2, 0.4]} />
                <meshStandardMaterial color={color} roughness={0.5} />
              </mesh>
            );
          })}
          {/* memory controller */}
          <mesh position={L.mc[s]!}>
            <boxGeometry args={[0.26, 0.3, 0.9]} />
            <meshStandardMaterial color={mode === "program" ? mix(col("--muted"), col("--c4"), nodeUtil[s] ?? 0) : col("--muted")} />
          </mesh>
          {/* DIMMs */}
          <group onClick={(e) => { if (mode === "one" && isClick(e)) { e.stopPropagation(); onNode(s); } }} onPointerOver={pointer(true)} onPointerOut={pointer(false)}>
            {[0, 1, 2, 3].map((d) => {
              const x = L.mem[s]!.x + L.side[s]! * (d - 1.5) * 0.24;
              const lit = mode === "one" ? s === node : (nodeUtil[s] ?? 0) > 0;
              return (
                <mesh key={d} position={[x, 0.45, p.z]}>
                  <boxGeometry args={[0.1, 0.9, 1.9]} />
                  <meshStandardMaterial color={lit ? nodeCol(s) : mix(nodeCol(s), col("--border"), 0.6)} emissive={nodeCol(s)} emissiveIntensity={lit ? 0.18 : 0} roughness={0.45} />
                </mesh>
              );
            })}
          </group>
        </group>
      ))}
      {linkCurves.map(({ a, b, curve }) => {
        const u = linkUtil.get(`${a}-${b}`) ?? 0;
        const onPath = mode === "one" && from !== node && ((a === from && b === node) || (b === from && a === node));
        const color = mode === "program" ? mix(col("--faint"), col("--c4"), u) : onPath ? col("--c4") : col("--faint");
        return <Tube key={`${a}-${b}`} curve={curve} radius={mode === "program" ? 0.05 + 0.07 * u : onPath ? 0.08 : 0.05} color={color} opacity={mode === "one" && !onPath ? 0.55 : 0.9} />;
      })}
      {path && <Tube curve={path} radius={0.035} color={col("--c4")} opacity={0.45} />}
      <Packets packets={packets} />
      <OrbitControls target={[0, 0.2, 0]} enablePan={false} enableZoom={false} minPolarAngle={0.25} maxPolarAngle={1.35} />
    </>
  );
}

// ---------------- the demo ----------------

const schema = {
  mode: select({ label: "View", options: [{ value: "one", label: "One access" }, { value: "program", label: "Whole program" }], default: "one", segmented: true }),
  sockets: select({ label: "Sockets", options: ["2", "4"].map((v) => ({ value: v, label: v })), default: "2", segmented: true }),
  from: select({ label: "Thread runs on socket", options: ["0", "1", "2", "3"].map((v) => ({ value: v, label: v })), default: "0", segmented: true }),
  node: select({ label: "Data is on memory node", options: ["0", "1", "2", "3"].map((v) => ({ value: v, label: v })), default: "1", segmented: true }),
  threads: range({ label: "Threads", min: 1, max: 32, step: 1, default: 16 }),
  placement: select<Placement>({ label: "Page placement", options: (Object.keys(PLACEMENT_LABEL) as Placement[]).map((p) => ({ value: p, label: PLACEMENT_LABEL[p] })), default: "serial-first-touch", segmented: true }),
};

export function Topology3DDemo() {
  const theme = useTheme();
  const params = useParams("topo", schema);
  const v = params.values;
  const sockets = Number(v.sockets);
  const mode = v.mode as "one" | "program";
  const from = Math.min(Number(v.from), sockets - 1);
  const node = Math.min(Number(v.node), sockets - 1);
  const [core, setCore] = useState(5);
  const [wrap, w] = useWidth<HTMLDivElement>();
  const height = w < 520 ? (sockets === 2 ? 280 : 320) : sockets === 2 ? 330 : 400;
  const L = useMemo(() => layout(sockets), [sockets]);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);

  const one = accessPath(from, node, 1);
  const all = accessPath(from, node, CORES_PER_SOCKET);
  const flows = useMemo(() => numaFlows({ ...NUMA_DEFAULTS, sockets, threads: v.threads, placement: v.placement }), [sockets, v.threads, v.placement]);

  const scene = useMemo(() => {
    const active = new Map<string, number>();
    const linkUtil = new Map<string, number>();
    const packets: Packet[] = [];
    let path: THREE.Curve<THREE.Vector3> | null = null;
    const dur = (local: boolean) => (local ? NUMA_DEFAULTS.latLocal : NUMA_DEFAULTS.latRemote) / 60;
    if (mode === "one") {
      const curve = dataPath(L, node, from, core);
      path = curve;
      packets.push({ curve, dur: dur(from === node), phase: 0, color: theme["--fg"], size: 0.1, reverse: "out" });
      packets.push({ curve, dur: dur(from === node), phase: 0, color: theme[NODE_VAR[node]!], size: 0.14, reverse: "back" });
    } else {
      for (const t of flows.threads) {
        active.set(`${t.socket}:${t.core}`, t.t);
        t.fromNode.forEach((g, j) => {
          if (g <= 0) return;
          const curve = dataPath(L, j, t.socket, t.core);
          const k = Math.max(1, Math.round(g / 2.5));
          for (let q = 0; q < k; q++) packets.push({ curve, dur: dur(j === t.socket), phase: (q / k + t.t * 0.137 + j * 0.31) % 1, color: theme[NODE_VAR[j]!], size: 0.09 });
        });
      }
      for (const [a, b] of L.pairs) {
        const u = Math.max(...flows.links.filter((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a)).map((l) => l.util), 0);
        linkUtil.set(`${a}-${b}`, u);
      }
    }
    return { active, linkUtil, packets, path };
  }, [mode, L, node, from, core, flows, theme]);

  const onlyOne: (keyof typeof schema)[] = ["mode", "sockets", "from", "node"];
  const onlyProgram: (keyof typeof schema)[] = ["mode", "sockets", "threads", "placement"];
  const socketOpts = Array.from({ length: sockets }, (_, i) => ({ value: String(i), label: String(i) }));
  const res = flows.res;
  const busyLinks = flows.links.filter((l) => l.gbps > 0.05);
  const labels: LabelDef[] = L.sockets.flatMap((p, s) => [
    { at: V(p.x, -0.1, p.z + 1.5), text: `socket ${s}` },
    { at: V(L.mem[s]!.x, 1.3, p.z), text: `memory ${s}${mode === "program" ? ` · ${pct(flows.nodes[s]?.util ?? 0, 0)}` : ""}`, color: NODE_CSS[s] },
  ]);
  const anchors = useMemo(() => labels.map((l) => l.at), [L]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Demo
      title={mode === "one" ? `One memory access on a ${sockets}-socket machine` : `${v.threads} threads streaming on a ${sockets}-socket machine`}
      controls={
        <>
          {(mode === "one" ? onlyOne : onlyProgram).map((k) => {
            const spec = k === "from" || k === "node" ? { ...schema[k], options: socketOpts } : schema[k];
            const value = k === "from" ? String(from) : k === "node" ? String(node) : v[k];
            return <Param key={k} spec={spec} value={value} onChange={(x) => params.set(k, x as never)} />;
          })}
        </>
      }
    >
      <div ref={wrap} style={{ position: "relative", height, borderRadius: 6, border: "1px solid var(--border)", background: "var(--subtle)", overflow: "hidden", touchAction: "pan-y" }}>
        <div className="muted" style={{ position: "absolute", left: 10, top: 8, fontSize: 11.5, zIndex: 6, pointerEvents: "none", maxWidth: "calc(100% - 20px)" }}>
          {mode === "one" ? "Click a core and a memory stack. Drag to turn." : "Each dot is data on its way to a core. Its color is the node it comes from."}
        </div>
        <Canvas camera={{ position: [0, 6.5, 7.5], fov: 40 }} dpr={[1, 2]} fallback={<div className="empty">WebGL is not available in this browser.</div>}>
          <Scene
            theme={theme} sockets={sockets} mode={mode} from={from} node={node} core={core}
            active={scene.active} linkUtil={scene.linkUtil} nodeUtil={flows.nodes.map((x) => x.util)} packets={scene.packets} path={scene.path}
            onCore={(s, c) => { params.set("from", String(s)); setCore(c); }}
            onNode={(j) => params.set("node", String(j))}
          />
          <LabelProjector anchors={anchors} refs={labelRefs} />
        </Canvas>
        {labels.map((l, i) => (
          <div key={l.text.split(" · ")[0]} ref={(el) => { labelRefs.current[i] = el; }} style={{ ...labelStyle, borderColor: l.color ?? "var(--border)", visibility: "hidden" }}>{l.text}</div>
        ))}
      </div>
      {mode === "one" ? (
        <>
          <div style={{ fontSize: 12.5, margin: "10px 0", overflowWrap: "anywhere" }}>
            <span className="muted">Path of the data: </span>
            {[...one.path].reverse().join(" → ")}
          </div>
          <Stats items={[
            { label: one.local ? "latency (local)" : "latency (remote)", value: `${one.latency} ns` },
            { label: "socket links crossed", value: one.linkHops },
            { label: "one core can stream", value: `${one.gbps} GB/s` },
            { label: `all ${CORES_PER_SOCKET} cores of socket ${from} together`, value: `${all.gbps} GB/s` },
          ]} />
          <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
            {one.local
              ? `The data is local. ${CORES_PER_SOCKET} cores together are limited by the ${all.bottleneck} of node ${node}.`
              : `The request and the data both cross the link from socket ${from} to socket ${node}. ${CORES_PER_SOCKET} cores together are limited by the ${all.bottleneck}.`}{" "}
            The dark dot is the request; the colored dot is the data coming back. A remote trip takes {NUMA_DEFAULTS.latRemote} ns, a local trip {NUMA_DEFAULTS.latLocal} ns.
          </p>
        </>
      ) : (
        <>
          <div style={{ marginTop: 10 }}>
            <Stats items={[
              { label: "total bandwidth", value: `${Math.round(res.gbps)} GB/s` },
              { label: "limited by", value: res.bottleneck },
              { label: "remote accesses", value: pct(res.remoteFraction, 0) },
              { label: "average latency", value: `${Math.round(res.latency)} ns` },
            ]} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10, fontSize: 11.5 }}>
            {flows.nodes.map((n, j) => (
              <span key={`n${j}`} style={{ border: `1px solid ${NODE_CSS[j]}`, borderRadius: 4, padding: "1px 6px" }}>memory {j}: {Math.round(n.gbps)} of {NUMA_DEFAULTS.memBW} GB/s</span>
            ))}
            {busyLinks.length > 2 && new Set(busyLinks.map((l) => Math.round(l.gbps))).size === 1 ? (
              <span style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px" }}>each of the {busyLinks.length} link directions: {Math.round(busyLinks[0]!.gbps)} of {NUMA_DEFAULTS.linkBW} GB/s</span>
            ) : busyLinks.map((l) => (
              <span key={`${l.from}-${l.to}`} style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px", color: l.util > 0.99 ? "var(--c4)" : "var(--fg)" }}>link {l.from} → {l.to}: {Math.round(l.gbps)} of {NUMA_DEFAULTS.linkBW} GB/s</span>
            ))}
            {!busyLinks.length && <span className="muted">no data crosses a socket link</span>}
          </div>
        </>
      )}
    </Demo>
  );
}
