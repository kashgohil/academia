/** Lazy wrappers so three.js loads only when a 3D demo is on screen. */
import { lazy, Suspense } from "react";

const IterationSpace = lazy(() => import("./IterationSpace3D").then((m) => ({ default: m.IterationSpaceDemo })));

const Loading = ({ h }: { h: number }) => <div className="demo" style={{ height: h, display: "grid", placeItems: "center" }}><span className="muted" style={{ fontSize: 13 }}>Loading 3D view…</span></div>;

export function IterationSpaceDemo() {
  return <Suspense fallback={<Loading h={420} />}><IterationSpace /></Suspense>;
}
