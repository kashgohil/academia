/** 3D view: a binary search tree and a B+ tree with the same keys, one slab per level. Lazy-loaded. */
import { useEffect, useMemo, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { Demo, Stats, Param, range, select, si, bytes, cssVar } from "../../kit";
import { levelSizes, bstDepth, leafShare } from "../../sims/db/btree";

const BST_NODE = 24; // key + two pointers
const ENTRY = 16; // key + pointer
const GAP = 0.45;
const MAX_SIDE = 6;
const MIN_SIDE = 0.14;

interface Stack { levels: { nodes: number; bytes: number }[] }

function bstLevels(n: number): Stack {
  const d = bstDepth(n);
  const out: Stack["levels"] = [];
  let left = n;
  for (let i = 0; i < d; i++) {
    const nodes = Math.min(left, Math.pow(2, i));
    out.push({ nodes, bytes: nodes * BST_NODE });
    left -= nodes;
  }
  return { levels: out };
}
function bpLevels(n: number, fanout: number): Stack {
  return { levels: levelSizes(n, fanout, fanout).map((nodes) => ({ nodes, bytes: nodes * fanout * ENTRY })) };
}

function Slabs({ stack, x, color, scale, path }: { stack: Stack; x: number; color: string; scale: number; path: string }) {
  const top = (stack.levels.length - 1) * GAP;
  const c = useMemo(() => new THREE.Color(color), [color]);
  return (
    <group position={[x, 0, 0]}>
      {stack.levels.map((l, i) => {
        const side = Math.max(MIN_SIDE, Math.sqrt(l.bytes) * scale);
        return (
          <mesh key={i} position={[0, top - i * GAP, 0]}>
            <boxGeometry args={[side, 0.07, side]} />
            <meshStandardMaterial color={c} transparent opacity={0.8} />
          </mesh>
        );
      })}
      {stack.levels.map((_, i) => (
        <mesh key={`p${i}`} position={[0, top - i * GAP + 0.09, 0]}>
          <sphereGeometry args={[0.07, 12, 8]} />
          <meshStandardMaterial color={path} />
        </mesh>
      ))}
      <mesh position={[0, top / 2, 0]}>
        <cylinderGeometry args={[0.015, 0.015, top + 0.2, 6]} />
        <meshStandardMaterial color={path} />
      </mesh>
    </group>
  );
}

function Fit({ h, w }: { h: number; w: number }) {
  const { camera } = useThree();
  useEffect(() => {
    const d = Math.max(h * 1.35, w * 1.25);
    camera.position.set(d * 0.3, h * 0.45 + d * 0.42, d * 0.92);
    camera.lookAt(0, h * 0.45, 0);
  }, [camera, h, w]);
  return null;
}

export function TreeShape3D() {
  const [logN, setLogN] = useState(7);
  const [fanout, setFanout] = useState("256");
  const n = Math.round(Math.pow(10, logN));
  const f = Number(fanout);
  const bst = useMemo(() => bstLevels(n), [n]);
  const bp = useMemo(() => bpLevels(n, f), [n, f]);
  const maxBytes = Math.max(...bst.levels.map((l) => l.bytes), ...bp.levels.map((l) => l.bytes));
  const scale = MAX_SIDE / Math.sqrt(maxBytes);
  const colors = useMemo(() => ({ bst: cssVar("--c2") || "#888", bp: cssVar("--c1") || "#36c", path: cssVar("--c4") || "#c33" }), []);
  const height = (bst.levels.length - 1) * GAP;
  const share = leafShare(n, f, f);
  const upper = bp.levels.slice(0, -1).reduce((a, l) => a + l.bytes, 0);
  return (
    <Demo
      title="The same keys as a binary search tree and as a B+ tree"
      controls={
        <>
          <Param spec={range({ label: "Number of keys N", min: 3, max: 9, step: 0.1, default: 7, format: (v) => si(Math.round(Math.pow(10, v))) })} value={logN} onChange={(v) => setLogN(v as number)} />
          <Param spec={select({ label: "B+ tree fanout", options: ["16", "64", "256", "1024"].map((v) => ({ value: v, label: v })), default: "256", segmented: true })} value={fanout} onChange={(v) => setFanout(v as string)} />
        </>
      }
    >
      <div style={{ position: "relative", height: 340, borderRadius: 6, border: "1px solid var(--border)", background: "var(--subtle)" }}>
        <div style={{ position: "absolute", left: 10, top: 8, zIndex: 1, pointerEvents: "none", fontSize: 12, lineHeight: 1.4 }}>
          <div style={{ color: "var(--c2)" }}>Binary search tree: {bst.levels.length} levels</div>
          <div style={{ color: "var(--c1)" }}>B+ tree, fanout {f}: {bp.levels.length} levels</div>
          <div style={{ color: "var(--c4)" }}>One lookup visits one node per level (dots)</div>
        </div>
        <div className="muted" style={{ position: "absolute", right: 10, bottom: 8, zIndex: 1, pointerEvents: "none", fontSize: 11.5 }}>Area of a slab = bytes in that level. Drag to turn.</div>
        <Canvas camera={{ position: [8, 10, 14], fov: 40 }} dpr={[1, 2]} fallback={<div className="empty">WebGL is not available in this browser.</div>}>
          <ambientLight intensity={0.75} />
          <directionalLight position={[8, 14, 6]} intensity={1.1} />
          <Fit h={height} w={MAX_SIDE * 2.4} />
          <Slabs stack={bst} x={-MAX_SIDE * 0.62} color={colors.bst} scale={scale} path={colors.path} />
          <Slabs stack={bp} x={MAX_SIDE * 0.62} color={colors.bp} scale={scale} path={colors.path} />
          <OrbitControls enablePan={false} enableZoom={false} target={[0, height * 0.45, 0]} />
        </Canvas>
      </div>
      <div style={{ height: 10 }} />
      <Stats
        items={[
          { label: "binary tree: node visits per lookup", value: bst.levels.length },
          { label: "B+ tree: node visits per lookup", value: bp.levels.length },
          { label: "B+ tree bytes in the leaf level", value: `${(share * 100).toFixed(1)}%` },
          { label: "B+ tree levels above the leaves", value: bytes(upper) },
        ]}
      />
    </Demo>
  );
}
