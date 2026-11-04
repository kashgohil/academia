/** The radix tree in 3D: one layer per level, one plate per table that exists, one cell per used entry. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Demo, Param, Stats, cssVar, range, useParams, useWidth } from "../../kit";
import { ENTRIES_PER_TABLE, GiB, LEVEL_NAMES, PAGE_SIZE, PageTable, flatTableBytes, fmtBytes, hexVa, splitVa, type TableNode } from "../../sims/os/vm";
import { seg } from "../db/StorageUi";

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

// ---------------- workloads ----------------

type Workload = "process" | "one" | "dense" | "sparse";
interface Built { pt: PageTable; pages: bigint[]; label: string }

function build(w: Workload): Built {
  const pt = new PageTable();
  const pages: bigint[] = [];
  const add = (va: bigint) => { pt.map(va, 0x100 + pages.length, { writable: true }); pages.push(va); };
  if (w === "one") add(0x7f0000000000n);
  if (w === "process") {
    for (let i = 0n; i < 12n; i++) add(0x555555554000n + i * 4096n);
    for (let i = 0n; i < 24n; i++) add(0x555555c00000n + i * 4096n);
    for (let i = 0n; i < 60n; i++) add(0x7f1234400000n + i * 4096n);
    for (let i = 0n; i < 8n; i++) add(0x7ffffffde000n + i * 4096n);
  }
  if (w === "dense") for (let i = 0n; i < 8192n; i++) add(0x7f0000000000n + i * 4096n);
  if (w === "sparse") for (let i = 0n; i < 64n; i++) add(0x7f0000000000n + i * BigInt(GiB));
  return { pt, pages, label: w };
}

// ---------------- layout ----------------

const CELLS = 23; // 23 × 23 = 529 cells hold the 512 entries of a table
const LAYER_GAP = 1.7;
const layerY = (l: number) => (3 - l) * LAYER_GAP - 2.3;

interface Plate { node: TableNode; x: number; z: number; size: number }

function layoutPlates(nodes: TableNode[]): Plate[] {
  const byLevel: TableNode[][] = [[], [], [], []];
  for (const n of nodes) byLevel[n.level]!.push(n);
  const out: Plate[] = [];
  byLevel.forEach((list) => {
    const cols = Math.ceil(Math.sqrt(list.length));
    const rows = Math.ceil(list.length / cols);
    const size = Math.min(2.2, 6.4 / Math.max(cols, rows) - 0.1);
    const step = size + 0.1 + (cols === 1 ? 0 : 0.06);
    list.forEach((node, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      out.push({ node, x: (c - (cols - 1) / 2) * step, z: (r - (rows - 1) / 2) * step, size });
    });
  });
  return out;
}

const cellPos = (p: Plate, index: number): [number, number] => {
  const cs = p.size / CELLS;
  const c = index % CELLS, r = Math.floor(index / CELLS);
  return [p.x + (c - (CELLS - 1) / 2) * cs, p.z + (r - (CELLS - 1) / 2) * cs];
};

// ---------------- scene ----------------

function Plates({ plates, theme }: { plates: Plate[]; theme: Theme }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const t = new THREE.Object3D();
    plates.forEach((p, i) => {
      t.position.set(p.x, layerY(p.node.level) - 0.04, p.z);
      t.scale.set(p.size, 0.05, p.size);
      t.updateMatrix();
      m.setMatrixAt(i, t.matrix);
    });
    m.count = plates.length;
    m.instanceMatrix.needsUpdate = true;
  }, [plates]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, Math.max(1, plates.length)]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={theme["--faint"]} transparent opacity={0.45} roughness={0.8} />
    </instancedMesh>
  );
}

function Cells({ plates, theme, path }: { plates: Plate[]; theme: Theme; path: Set<string> }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const total = useMemo(() => plates.reduce((a, p) => a + p.node.used.length, 0), [plates]);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const t = new THREE.Object3D();
    const c = new THREE.Color();
    const palette = [theme["--c1"], theme["--c3"], theme["--c5"], theme["--c2"]];
    let i = 0;
    for (const p of plates) {
      const cs = p.size / CELLS;
      for (const idx of p.node.used) {
        const [x, z] = cellPos(p, idx);
        const on = path.has(`${p.node.pfn}:${idx}`);
        const size = Math.max(cs * (on ? 2.2 : 0.86), 0.012);
        t.position.set(x, layerY(p.node.level) + (on ? 0.1 : 0.02), z);
        t.scale.set(size, on ? 0.2 : 0.05, size);
        t.updateMatrix();
        m.setMatrixAt(i, t.matrix);
        m.setColorAt(i, c.set(on ? theme["--fg"] : palette[p.node.level]!));
        i++;
      }
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [plates, theme, path]);
  return (
    <instancedMesh key={total} ref={ref} args={[undefined, undefined, Math.max(1, total)]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.5} />
    </instancedMesh>
  );
}

function Links({ segments, color, opacity }: { segments: number[]; color: string; opacity: number }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
    return g;
  }, [segments]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </lineSegments>
  );
}

function WalkToken({ points, color }: { points: THREE.Vector3[]; color: string }) {
  const ref = useRef<THREE.Mesh>(null);
  const curve = useMemo(() => (points.length >= 2 ? new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.01) : null), [points]);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m || !curve) return;
    m.position.copy(curve.getPointAt((clock.getElapsedTime() / 2.4) % 1));
  });
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.09, 14, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
    </mesh>
  );
}

function CameraRig() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const tanV = Math.tan((camera.fov * Math.PI) / 360), tanH = tanV * aspect;
    const d = Math.max(5.2 / tanH, 4.5 / tanV) * 1.02;
    camera.position.copy(new THREE.Vector3(0.55, 0.42, 0.72).normalize().multiplyScalar(d));
    camera.lookAt(0, -0.35, 0);
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);
  return null;
}

const labelStyle: CSSProperties = { position: "absolute", left: 0, top: 0, zIndex: 2, pointerEvents: "none", fontSize: 11, lineHeight: 1.2, whiteSpace: "nowrap", padding: "1px 6px", borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg)", userSelect: "none", willChange: "transform" };

function LabelProjector({ anchors, refs }: { anchors: THREE.Vector3[]; refs: { current: (HTMLDivElement | null)[] } }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    anchors.forEach((a, i) => {
      const el = refs.current[i];
      if (!el) return;
      v.copy(a).project(camera);
      const x = (v.x * 0.5 + 0.5) * size.width, y = (-v.y * 0.5 + 0.5) * size.height;
      const halfW = el.offsetWidth / 2 + 2;
      el.style.transform = `translate(${Math.max(halfW, Math.min(size.width - halfW, x)).toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    });
  });
  return null;
}

// ---------------- demo ----------------

/** Number of tables that a level would hold if every entry above it were used. */
const possible = (l: number) => ENTRIES_PER_TABLE ** l;

export function VmPageTable3DDemo() {
  const theme = useTheme();
  const p = useParams("vm3d", {
    work: seg<Workload>("What the process maps", [["process", "A small process"], ["one", "One page"], ["dense", "32 MiB, dense"], ["sparse", "64 pages, 1 GiB apart"]], "process"),
    target: range({ label: "Page to walk (as a fraction of the mapped pages)", min: 0, max: 100, step: 1, default: 40, format: (v) => `${v}%` }),
  });
  const work = p.values.work;
  const built = useMemo(() => build(work), [work]);
  const nodes = useMemo(() => built.pt.nodes(), [built]);
  const plates = useMemo(() => layoutPlates(nodes), [nodes]);
  const va = built.pages[Math.min(built.pages.length - 1, Math.floor((p.values.target / 100) * built.pages.length))]!;
  const walk = useMemo(() => built.pt.walk(va, {}, { readOnly: true }), [built, va]);
  const plateOf = useMemo(() => new Map(plates.map((q) => [q.node.pfn, q])), [plates]);
  const path = useMemo(() => new Set(walk.events.map((e) => `${e.tablePfn}:${e.index}`)), [walk]);

  const allLinks = useMemo(() => {
    const seg: number[] = [];
    const byKey = new Map(plates.map((q) => [q.node.path.join("/"), q]));
    if (plates.length > 200) return seg;
    for (const q of plates) {
      if (q.node.level === 3) continue;
      for (const idx of q.node.used) {
        const child = byKey.get([...q.node.path, idx].join("/"));
        if (!child) continue;
        const [x, z] = cellPos(q, idx);
        seg.push(x, layerY(q.node.level), z, child.x, layerY(child.node.level), child.z);
      }
    }
    return seg;
  }, [plates]);
  const walkPts = useMemo(() => {
    const pts: THREE.Vector3[] = [new THREE.Vector3(0, layerY(0) + 0.7, 0)];
    for (const e of walk.events) {
      const q = plateOf.get(e.tablePfn);
      if (!q) continue;
      const [x, z] = cellPos(q, e.index);
      pts.push(new THREE.Vector3(x, layerY(e.level) + 0.1, z));
    }
    return pts;
  }, [walk, plateOf]);
  const walkSeg = useMemo(() => {
    const seg: number[] = [];
    for (let i = 0; i + 1 < walkPts.length; i++) seg.push(...walkPts[i]!.toArray(), ...walkPts[i + 1]!.toArray());
    return seg;
  }, [walkPts]);

  const counts = LEVEL_NAMES[4].map((_, l) => nodes.filter((n) => n.level === l).length);
  const anchors = useMemo(() => [0, 1, 2, 3].map((l) => new THREE.Vector3(-3.9, layerY(l) + 0.25, 2.6)), []);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [wrap, w] = useWidth<HTMLDivElement>();
  const height = w < 520 ? 340 : 430;
  const f = splitVa(va);
  const mapped = built.pages.length * PAGE_SIZE;
  return (
    <Demo
      title="The tree that does not exist: PML4, PDPT, PD and PT as layers"
      controls={<>
        <Param spec={p.schema.work} value={work} onChange={(x) => p.set("work", x as Workload)} />
        <Param spec={p.schema.target} value={p.values.target} onChange={(x) => p.set("target", x as number)} />
      </>}
    >
      <div ref={wrap} style={{ position: "relative", height, borderRadius: 6, border: "1px solid var(--border)", background: "var(--subtle)", overflow: "hidden", touchAction: "pan-y" }}>
        <div className="muted" style={{ position: "absolute", left: 10, top: 8, fontSize: 11.5, zIndex: 3, pointerEvents: "none", maxWidth: "calc(100% - 20px)" }}>Each plate is one 4 KiB table. Each small block is one used entry. Drag to turn.</div>
        <Canvas camera={{ position: [4, 4, 6], fov: 38 }} dpr={[1, 2]} fallback={<div className="empty">WebGL is not available in this browser.</div>}>
          <ambientLight intensity={0.85} />
          <directionalLight position={[5, 9, 6]} intensity={1.05} />
          <CameraRig />
          <Plates plates={plates} theme={theme} />
          <Cells plates={plates} theme={theme} path={path} />
          {allLinks.length > 0 && <Links segments={allLinks} color={theme["--muted"]} opacity={0.4} />}
          <Links segments={walkSeg} color={theme["--c4"]} opacity={1} />
          <WalkToken points={walkPts} color={theme["--c4"]} />
          <LabelProjector anchors={anchors} refs={labelRefs} />
          <OrbitControls target={[0, -0.35, 0]} enablePan={false} enableZoom={false} minPolarAngle={0.5} maxPolarAngle={1.45} />
        </Canvas>
        {LEVEL_NAMES[4].map((n, l) => (
          <div key={n} ref={(el) => { labelRefs.current[l] = el; }} style={labelStyle}>{n}: {counts[l]!.toLocaleString("en-US")}</div>
        ))}
      </div>
      <div style={{ fontSize: 12.5, margin: "10px 0", overflowWrap: "anywhere" }}>
        <span className="muted">Red path: </span>
        <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{hexVa(va)}</span>
        <span className="muted"> indexes </span>{f.indices.join(" → ")}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}><th style={{ padding: "2px 6px" }}>level</th><th style={{ padding: "2px 6px" }}>tables that exist</th><th style={{ padding: "2px 6px" }}>tables possible</th></tr>
          </thead>
          <tbody>
            {LEVEL_NAMES[4].map((n, l) => (
              <tr key={n} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "2px 6px" }}>{n}</td>
                <td style={{ padding: "2px 6px" }}>{counts[l]!.toLocaleString("en-US")}</td>
                <td style={{ padding: "2px 6px" }}>{possible(l).toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "memory mapped", value: fmtBytes(mapped) },
          { label: "page tables", value: fmtBytes(built.pt.tableBytes) },
          { label: "a flat table", value: fmtBytes(flatTableBytes(48)) },
          { label: "tables / mapped", value: `${((built.pt.tableBytes / mapped) * 100).toFixed(1)}%` },
        ]} />
      </div>
    </Demo>
  );
}
