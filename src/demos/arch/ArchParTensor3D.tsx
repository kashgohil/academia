/** 3D view of a GEMM iteration space, cut into tensor-core tiles. Loaded lazily by ArchParTensorDemos. */
import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Controls, Demo, StepButtons, StepSlider, Stats, cssVar, int, seg, useParams, useStepper } from "../../kit";
import { tileGemm, type Shape } from "../../sims/arch/parallel";

const M = 48, N = 32, K = 48;
const SCALE = 0.1;

interface Tile { i: number; j: number; k: number }

function order(s: Shape): Tile[] {
  const t = tileGemm(M, N, K, s);
  const out: Tile[] = [];
  // For each output tile, run along k: the accumulator stays in registers.
  for (let i = 0; i < t.tm; i++) for (let j = 0; j < t.tn; j++) for (let k = 0; k < t.tk; k++) out.push({ i, j, k });
  return out;
}

function Box({ pos, size, color, opacity }: { pos: [number, number, number]; size: [number, number, number]; color: string; opacity: number }) {
  return (
    <mesh position={pos}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} transparent opacity={opacity} depthWrite={opacity > 0.9} />
    </mesh>
  );
}

export function ArchParTiles3D() {
  const p = useParams("partiles", { shape: seg<"16-8-16" | "8-8-4">("MMA tile", [["16-8-16", "m16n8k16"], ["8-8-4", "m8n8k4"]], "16-8-16") });
  const [tm, tn, tk] = p.values.shape.split("-").map(Number) as [number, number, number];
  const s: Shape = { m: tm, n: tn, k: tk };
  const tiles = useMemo(() => order(s), [tm, tn, tk]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useStepper(tiles.length, 4);
  const cur = tiles[st.i]!;
  const colors = useMemo(() => ({ done: cssVar("--c3") || "#1d9a5b", cur: cssVar("--c4") || "#c9372c", a: cssVar("--c1") || "#2a5bd7", b: cssVar("--c2") || "#e07b14", frame: cssVar("--muted") || "#888" }), []);
  // World coordinates: x = column j (N), y = −row i (M), z = k (depth). Centered.
  const at = (i: number, j: number, k: number, di: number, dj: number, dk: number): [number, number, number] =>
    [(j + dj / 2 - N / 2) * SCALE, (M / 2 - i - di / 2) * SCALE, (k + dk / 2 - K / 2) * SCALE];
  const doneCount = st.i;
  const frameGeo = useMemo(() => new THREE.BoxGeometry(N * SCALE, M * SCALE, K * SCALE), []);
  return (
    <Demo title="A GEMM is a box of multiply-adds; a tensor core eats one small box at a time" actions={<StepButtons s={st} />} controls={<><StepSlider s={st} label="Tile" /><Controls params={p} /></>}>
      <div style={{ position: "relative", height: 340, borderRadius: 6, border: "1px solid var(--border)", background: "var(--subtle)" }}>
        <div className="muted" style={{ position: "absolute", left: 10, top: 8, fontSize: 11.5, zIndex: 1, pointerEvents: "none" }}>across: j (N = 32) · down: i (M = 48) · depth: k (K = 48)</div>
        <Canvas camera={{ position: [6.5, 4.5, 8.5], fov: 45 }} dpr={[1, 2]} fallback={<div className="empty">WebGL is not available in this browser.</div>}>
          <ambientLight intensity={0.75} />
          <directionalLight position={[6, 8, 5]} intensity={1.1} />
          <lineSegments>
            <edgesGeometry args={[frameGeo]} />
            <lineBasicMaterial color={colors.frame} />
          </lineSegments>
          {tiles.slice(0, doneCount).map((t, q) => (
            <Box key={q} pos={at(t.i * tm, t.j * tn, t.k * tk, tm, tn, tk)} size={[tn * SCALE * 0.96, tm * SCALE * 0.96, tk * SCALE * 0.96]} color={colors.done} opacity={0.35} />
          ))}
          <Box pos={at(cur.i * tm, cur.j * tn, cur.k * tk, tm, tn, tk)} size={[tn * SCALE, tm * SCALE, tk * SCALE]} color={colors.cur} opacity={0.95} />
          {/* The A slab (rows i, depth k) projected on the left face, and the B slab (depth k, columns j) on the top face. */}
          <Box pos={[(-N / 2) * SCALE - 0.06, at(cur.i * tm, 0, cur.k * tk, tm, 0, tk)[1], at(0, 0, cur.k * tk, 0, 0, tk)[2]]} size={[0.04, tm * SCALE, tk * SCALE]} color={colors.a} opacity={0.95} />
          <Box pos={[at(0, cur.j * tn, 0, 0, tn, 0)[0], (M / 2) * SCALE + 0.06, at(0, 0, cur.k * tk, 0, 0, tk)[2]]} size={[tn * SCALE, 0.04, tk * SCALE]} color={colors.b} opacity={0.95} />
          <OrbitControls enablePan={false} enableZoom={false} />
        </Canvas>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Red: the tile that one MMA instruction computes. Blue on the left face: the piece of A it reads. Orange on top: the piece of B. Green: tiles done. Drag to turn.</p>
      <Stats items={[
        { label: `tile ${st.i + 1} of ${tiles.length}: (i, j, k)`, value: `(${cur.i}, ${cur.j}, ${cur.k})` },
        { label: "multiply-adds: the tile volume", value: int(tm * tn * tk) },
        { label: "inputs: the two faces", value: `${tm * tk} + ${tk * tn} = ${tm * tk + tk * tn}` },
        { label: "multiply-adds done", value: int((doneCount + 1) * tm * tn * tk) },
      ]} />
    </Demo>
  );
}
