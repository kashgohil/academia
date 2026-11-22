/** Demos for "Odin's context allocator": the implicit context on the stack, and who must change when a leaf allocates. */
import { useMemo, useState } from "react";
import { Banner, ButtonRow, Chip, Demo, MONO, MiniTable, Param, SectionLabel, StepButtons, StepCaption, StepSlider, Stats, mono, seg, tint, useParams, useStepper, useWidth, Arrow, bytes as fmtBytes } from "../../kit";
import { CALL_GRAPH, CONTEXT_SOURCE, TEMP_BLOCK, ripple, runContext, type Override, type Style } from "../../sims/sys/explicit";
import type { FrameSnap } from "../../sims/sys/mem";
import { HeapBlocks, StackView } from "./SysViews";
import { Code } from "./SysExpUi";

const CTX = { ov: seg<Override>("Set context.allocator", [["none", "nowhere"], ["track", "main: tracking"], ["temp", "serve: temp"], ["both", "both"]], "temp") };
const ALLOC_COLOR = { heap: "var(--c3)", tracking: "var(--c1)", temp: "var(--c5)" } as const;

export function OdinContextDemo() {
  const P = useParams("sys-exp-ctx", CTX);
  const ov = P.values.ov;
  const steps = useMemo(() => runContext(ov), [ov]);
  const s = useStepper(steps.length, 1.2);
  const cur = steps[s.i]!;
  const show = (tag?: "track" | "temp") => !tag || (tag === "track" ? ov === "track" || ov === "both" : ov === "temp" || ov === "both");
  const dim = new Set(CONTEXT_SOURCE.map((l, i) => (show(l.tag) ? 0 : i + 1)).filter((x) => x > 0));
  // short labels for the context slots, so the frames stay narrow
  const frames: FrameSnap[] = cur.snap.frames.map((f) => ({ ...f, slots: f.slots.map((sl) => (cur.labels[sl.id] ? { ...sl, text: cur.labels[sl.id]!, dangling: false } : sl.typeName === "struct Tracking_Allocator" ? { ...sl, text: "{backing = heap, …}" } : sl)) }));
  const tempUse = cur.tempUsed;
  return (
    <Demo
      title="The context travels with every call"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={CTX.ov} value={ov} onChange={(v) => { P.set("ov", v as Override); s.reset(); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Odin (unchecked: Odin is not installed here)</SectionLabel>
          <Code lines={CONTEXT_SOURCE.map((l) => l.text)} current={cur.line || undefined} dim={dim} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Which context each frame uses</SectionLabel>
          <MiniTable
            head={["frame", "context of", "allocator"]}
            rows={cur.frames.map((f) => [
              <span key="f" style={mono}>{f.fn}{f.ownCopy ? " (own copy)" : ""}</span>,
              <span key="u" style={mono}>{f.uses}</span>,
              <span key="a" style={{ ...mono, color: ALLOC_COLOR[f.allocator], fontWeight: 600 }}>{f.allocator}</span>,
            ])}
          />
          <SectionLabel>Stack (the context slots are shown in short form)</SectionLabel>
          <StackView frames={frames} />
        </div>
      </div>
      <SectionLabel>Heap</SectionLabel>
      <HeapBlocks blocks={cur.snap.heap} edges={cur.snap.edges.filter((e) => cur.snap.heap.some((b) => b.id === e.to))} empty="No heap blocks yet." />
      {(ov === "temp" || ov === "both") && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4, ...mono }}>
          temp arena: {tempUse} B in use of {fmtBytes(TEMP_BLOCK)}{cur.snap.heap.some((b) => b.label === "temp arena block") ? "" : " (block not made yet)"}
        </div>
      )}
      <StepCaption label={cur.line ? `line ${cur.line}` : "runtime"} tone={cur.via ? "info" : null}>{cur.caption}</StepCaption>
      {cur.report.length > 0 && (
        <Banner tone={cur.report.some((l) => l.includes("not freed") || l.includes("leak")) ? "bad" : "good"}>
          <div style={{ ...mono, fontSize: 12.5, whiteSpace: "pre-wrap" }}>{cur.report.join("\n")}</div>
        </Banner>
      )}
    </Demo>
  );
}

// ---------------------------------------------------------------- signature ripple

const RIP = { style: seg<Style>("Style", [["zig", "Zig: parameter"], ["odin", "Odin: context"], ["c", "C: global malloc"]], "zig") };
const LEAVES = CALL_GRAPH.filter((n) => n.leaf).map((n) => n.id);

export function SignatureRippleDemo() {
  const P = useParams("sys-exp-ripple", RIP);
  const style = P.values.style;
  const [alloc, setAlloc] = useState<Set<string>>(() => new Set(["query"]));
  const r = useMemo(() => ripple(alloc, style), [alloc, style]);
  const [ref, w] = useWidth<HTMLDivElement>(600);
  const W = Math.max(w, 340), H = 230, NW = 76, NH = 30;
  const px = (x: number) => NW / 2 + 6 + x * (W - NW - 12), py = (y: number) => NH / 2 + 6 + y * (H - NH - 12);
  const toggleLeaf = (id: string) => setAlloc((s) => { const t = new Set(s); if (t.has(id)) t.delete(id); else t.add(id); return t; });
  const sig = (id: string) => style === "zig" && r.changed.has(id) ? `fn ${id}(gpa: Allocator, …)` : style === "odin" ? `${id} :: proc(…)` : style === "c" ? `void ${id}(…)` : `fn ${id}(…)`;
  return (
    <Demo title="Who has to know about the allocator?" controls={<Param spec={RIP.style} value={style} onChange={(v) => P.set("style", v as Style)} />}>
      <SectionLabel style={{ marginTop: 0 }}>Click the leaf functions that allocate</SectionLabel>
      <ButtonRow>{LEAVES.map((id) => <Chip key={id} onClick={() => toggleLeaf(id)} filled={alloc.has(id)} color="var(--c2)">{id}</Chip>)}</ButtonRow>
      <div ref={ref} style={{ overflowX: "auto", marginTop: 8 }}>
        <svg width={W} height={H} style={{ display: "block", fontFamily: MONO, fontSize: 11 }}>
          <defs><Arrow id="rip-arrow" color="var(--faint)" /></defs>
          {CALL_GRAPH.flatMap((n) => n.calls.map((c) => {
            const to = CALL_GRAPH.find((x) => x.id === c)!;
            const hot = style === "zig" && r.changed.has(c);
            return <line key={n.id + c} x1={px(n.x)} y1={py(n.y) + NH / 2} x2={px(to.x)} y2={py(to.y) - NH / 2 - 2} stroke={hot ? "var(--c2)" : "var(--faint)"} strokeWidth={hot ? 2 : 1} markerEnd="url(#rip-arrow)" />;
          }))}
          {CALL_GRAPH.map((n) => {
            const changed = r.changed.has(n.id), allocs = alloc.has(n.id), reach = r.reach.has(n.id);
            const col = changed ? "var(--c2)" : reach && style === "odin" ? "var(--c5)" : "var(--border)";
            return (
              <g key={n.id} transform={`translate(${px(n.x) - NW / 2},${py(n.y) - NH / 2})`} onClick={n.leaf ? () => toggleLeaf(n.id) : undefined} style={{ cursor: n.leaf ? "pointer" : undefined }}>
                <rect width={NW} height={NH} rx={5} fill={allocs ? tint("var(--c2)", 30) : changed ? tint("var(--c2)", 12) : "var(--bg)"} stroke={col} strokeWidth={changed ? 2 : 1} strokeDasharray={reach && style === "odin" && !allocs ? "4 3" : undefined} />
                <text x={NW / 2} y={NH / 2} dy="0.35em" textAnchor="middle" style={{ fill: "var(--fg)", fontWeight: allocs ? 700 : 400 }}>{n.id}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ ...mono, fontSize: 12, display: "grid", gap: 2, marginTop: 6, overflowX: "auto" }}>
        {CALL_GRAPH.filter((n) => r.reach.has(n.id) && n.id !== "main").map((n) => <div key={n.id} style={{ whiteSpace: "nowrap", color: r.changed.has(n.id) ? "var(--c2)" : undefined }}>{sig(n.id)}</div>)}
      </div>
      <Stats items={[
        { label: "functions that allocate (directly or below)", value: r.reach.has("main") ? r.reach.size - 1 : r.reach.size },
        { label: "signatures that change", value: r.changed.size },
        { label: "callers can pick the allocator", value: style === "c" ? "no" : "yes" },
        { label: "visible in the signature", value: style === "zig" ? "yes" : "no" },
      ]} />
    </Demo>
  );
}
