/** 3D view: a table as a block of cells, cut into pages by rows (NSM, PAX) or by columns (DSM). Lazy-loaded. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Demo, Stats, Param, Legend, cssVar, pct, seg } from "../../kit";
import { Layout, footprint, cellsOf, wideSchema, type LayoutKind } from "../../sims/db/olap";

const COLS = 8, ROWS = 64, PAGE = 512; // 8-byte values: a page holds 64 values
const CW = 1, RD = 0.25, H = 0.45, GAP = 0.4, MINI = 0.14, LIFT = 1.6;
type Q = "one" | "three" | "row";
const QUERY: Record<Q, { label: string; cols: number[]; rows: number[] }> = {
  one: { label: "SUM(c3)", cols: [3], rows: Array.from({ length: ROWS }, (_, i) => i) },
  three: { label: "c1, c4, c5", cols: [1, 4, 5], rows: Array.from({ length: ROWS }, (_, i) => i) },
  row: { label: "row 21, all columns", cols: Array.from({ length: COLS }, (_, i) => i), rows: [21] },
};

function cellPos(kind: LayoutKind, r: number, c: number): [number, number] {
  const page = Math.floor(r / 8);
  let x = c * CW, z = r * RD;
  if (kind === "dsm") x += c * GAP;
  else { z += page * GAP; if (kind === "pax") x += c * MINI; }
  return [x, z];
}

function Cells({ kind, need, read, colors }: { kind: LayoutKind; need: Set<string>; read: Set<number>; colors: { need: THREE.Color; waste: THREE.Color; idle: THREE.Color } }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const L = useMemo(() => new Layout(kind, wideSchema(COLS), ROWS, PAGE), [kind]);
  const lift = useRef(new Float32Array(COLS * ROWS));
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const width = kind === "dsm" ? COLS * CW + (COLS - 1) * GAP : COLS * CW + (kind === "pax" ? (COLS - 1) * MINI : 0);
  const depth = ROWS * RD + (kind === "dsm" ? 0 : 7 * GAP);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const isRead = read.has(L.place(r, c).page);
      m.setColorAt(i, need.has(`${r},${c}`) ? colors.need : isRead ? colors.waste : colors.idle);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [L, need, read, colors]);
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    const k = Math.min(1, dt * 6);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const target = read.has(L.place(r, c).page) ? LIFT : 0;
      lift.current[i]! += (target - lift.current[i]!) * k;
      const [x, z] = cellPos(kind, r, c);
      tmp.position.set(x - width / 2 + CW / 2, lift.current[i]! + H / 2, z - depth / 2 + RD / 2);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
    <mesh position={[0, -0.04, 0]}>
      <boxGeometry args={[width + 0.6, 0.06, depth + 0.6]} />
      <meshStandardMaterial color={colors.idle} transparent opacity={0.6} />
    </mesh>
    <instancedMesh ref={ref} args={[undefined, undefined, COLS * ROWS]}>
      <boxGeometry args={[CW * 0.94, H, RD * 0.86]} />
      <meshStandardMaterial />
    </instancedMesh>
    </group>
  );
}

export function TableBlock3D() {
  const [kind, setKind] = useState<LayoutKind>("nsm");
  const [q, setQ] = useState<Q>("one");
  const def = QUERY[q];
  const L = useMemo(() => new Layout(kind, wideSchema(COLS), ROWS, PAGE), [kind]);
  const f = useMemo(() => footprint(L, cellsOf(def.rows, def.cols)), [L, def]);
  const need = useMemo(() => new Set(cellsOf(def.rows, def.cols).map(([r, c]) => `${r},${c}`)), [def]);
  const colors = useMemo(() => ({
    need: new THREE.Color(cssVar("--c1") || "#3366cc"),
    waste: new THREE.Color(cssVar("--c2") || "#cc8833"),
    idle: new THREE.Color(cssVar("--border") || "#cccccc"),
  }), []);
  return (
    <Demo
      title="A table as a block: which slices does a query lift out?"
      controls={
        <>
          <Param spec={seg<LayoutKind>("Layout", [["nsm", "NSM: pages of rows"], ["dsm", "DSM: pages of one column"], ["pax", "PAX"]], "nsm")} value={kind} onChange={(v) => setKind(v as LayoutKind)} />
          <Param spec={seg<Q>("Query reads", [["one", QUERY.one.label], ["three", QUERY.three.label], ["row", QUERY.row.label]], "one")} value={q} onChange={(v) => setQ(v as Q)} />
        </>
      }
    >
      <div style={{ position: "relative", height: 360, borderRadius: 6, border: "1px solid var(--border)", background: "var(--subtle)" }}>
        <div style={{ position: "absolute", left: 10, top: 8, zIndex: 1, pointerEvents: "none", fontSize: 12, lineHeight: 1.45 }}>
          <div>8 columns × 64 rows, 64 values per page</div>
          <div style={{ color: "var(--c1)" }}>{f.usefulBytes / 8} values needed</div>
          <div style={{ color: "var(--c2)" }}>{f.pages} of {L.pageCount} pages lifted (read)</div>
        </div>
        <div className="muted" style={{ position: "absolute", right: 10, bottom: 8, zIndex: 1, pointerEvents: "none", fontSize: 11.5 }}>Columns run left to right, rows front to back. Drag to turn.</div>
        <Canvas camera={{ position: [9, 11, 15], fov: 40 }} dpr={[1, 2]} fallback={<div className="empty">WebGL is not available in this browser.</div>}>
          <ambientLight intensity={0.8} />
          <directionalLight position={[6, 14, 8]} intensity={1.1} />
          <Cells kind={kind} need={need} read={f.pageIds} colors={colors} />
          <OrbitControls enablePan={false} enableZoom={false} target={[0, 0.6, 0]} />
        </Canvas>
      </div>
      <div style={{ marginTop: 6 }}>
        <Legend box items={[{ label: "needed value", color: "var(--c1)" }, { label: "read, not needed", color: "var(--c2)" }, { label: "not read", color: "var(--border)" }]} />
      </div>
      <Stats
        items={[
          { label: "pages read", value: `${f.pages} of ${L.pageCount}` },
          { label: "bytes read", value: `${f.diskBytes} B` },
          { label: "useful share", value: pct(f.usefulBytes / f.diskBytes, 0) },
        ]}
      />
    </Demo>
  );
}
