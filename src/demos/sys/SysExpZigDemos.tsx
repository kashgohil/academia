/** Demos for "Allocators as parameters in Zig": one function on six allocators, and checkAllAllocationFailures. */
import { useMemo, useState } from "react";
import { Banner, ButtonRow, Demo, IndexButtons, IndexSlider, MiniTable, Param, SectionLabel, Stats, mono, range, select, tint, toggle, useParams, bytes as fmtBytes } from "../../kit";
import { ALLOCATORS, BAD_EMAIL, ERRDEFER_LINES, LOAD_SOURCE, VALID_EMAIL, WORK_SOURCE, checkAll, runLoad, runWork, type AllocId, type LoadRun } from "../../sims/sys/explicit";
import { HeapBlocks } from "./SysViews";
import { Code, OWNER_COLOR, Regions } from "./SysExpUi";

const SWAP = {
  n: range({ label: "Items per list", min: 1, max: 300, step: 1, default: 40 }),
  allocator: select<AllocId>({ label: "Allocator", options: ALLOCATORS.map((a) => ({ value: a.id, label: a.label })), default: "page" }),
  two: toggle({ label: "Two lists grow at the same time", default: false }),
  forget: toggle({ label: "Forget defer gpa.free(report)", default: false }),
  fba: select({ label: "Buffer size", options: [{ value: "1024", label: "1 KiB" }, { value: "2048", label: "2 KiB" }, { value: "4096", label: "4 KiB" }], default: "4096", segmented: true }),
  fail: range({ label: "Fail allocation number", min: 0, max: 8, step: 1, default: 1 }),
};

const IMPL: Record<AllocId, string> = {
  page: "PageAllocator", c: "c_allocator_impl", fba: "FixedBufferAllocator", arena: "ArenaAllocator", testing: "SafeAllocator", failing: "FailingAllocator",
};

export function ZigSwapDemo() {
  const P = useParams("sys-exp-swap", SWAP);
  const { n, allocator, two, forget, fba, fail } = P.values;
  const run = useMemo(() => runWork({ allocator, n, two, forget, fbaSize: Number(fba), failIndex: fail }), [allocator, n, two, forget, fba, fail]);
  const [k, setK] = useState<number | null>(null);
  const last = run.steps.length - 1;
  // by default, show the memory just before the defers run: after the last alloc
  const lastAlloc = run.steps.map((x) => x.call.op).lastIndexOf("alloc");
  const at = k === null ? (lastAlloc >= 0 ? lastAlloc : last) : Math.min(k, last);
  const cur = run.steps[at];
  const dim = new Set<number>([...(two ? [] : [4, 5, 8]), ...(forget ? [11] : [])]);
  const scale = Math.max(1, ...run.steps.flatMap((s) => s.regions.map((r) => r.size)));
  const leakLines = run.report.filter((l) => l.includes("leaked"));
  const verdict = run.result !== "ok"
    ? { tone: "warn" as const, text: `work returned ${run.result}. The defers ran on the way out, so nothing leaked.` }
    : leakLines.length ? { tone: "bad" as const, text: `The test fails: ${leakLines.length} leak reported. ${leakLines[0]}` }
    : run.silentLeak ? { tone: "warn" as const, text: `${run.silentLeak} bytes are never freed, and ${ALLOCATORS.find((a) => a.id === allocator)!.label} says nothing about it.` }
    : forget && allocator === "arena" ? { tone: "good" as const, text: `report is never freed, but arena.deinit gives back every node: ${run.report.join(", ")}.` }
    : { tone: "good" as const, text: "work returned, and every allocation was freed." };
  return (
    <Demo
      title="Same code, other allocator"
      controls={<>
        <Param spec={SWAP.n} value={n} onChange={(v) => { P.set("n", v as number); setK(null); }} />
        <Param spec={SWAP.allocator} value={allocator} onChange={(v) => { P.set("allocator", v as AllocId); setK(null); }} />
        {allocator === "fba" && <Param spec={SWAP.fba} value={fba} onChange={(v) => { P.set("fba", v as never); setK(null); }} />}
        {allocator === "failing" && <Param spec={SWAP.fail} value={fail} onChange={(v) => { P.set("fail", v as number); setK(null); }} />}
        <Param spec={SWAP.two} value={two} onChange={(v) => { P.set("two", v as boolean); setK(null); }} />
        <Param spec={SWAP.forget} value={forget} onChange={(v) => { P.set("forget", v as boolean); setK(null); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>The code does not change</SectionLabel>
          <Code lines={WORK_SOURCE} current={cur?.line} dim={dim} />
          <div className="muted" style={{ fontSize: 12, marginTop: 6, ...mono, overflowWrap: "anywhere" }}>
            gpa = .{"{"} .ptr = &amp;state, .vtable = &amp;{IMPL[allocator]}.vtable {"}"} · 16 bytes
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>vtable call {at + 1} of {run.steps.length}</SectionLabel>
          {cur && (
            <div style={{ ...mono, fontSize: 12.5, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, minHeight: 64 }}>
              <div>
                <span style={{ color: OWNER_COLOR[cur.call.who] ?? "var(--fg)", fontWeight: 700 }}>{cur.call.who}</span>{" "}
                {cur.call.op}({cur.call.newLen !== undefined ? `${cur.call.len} → ${cur.call.newLen}` : cur.call.len}){" "}
                <span style={{ color: cur.call.ok ? "var(--c3)" : "var(--c4)" }}>
                  {cur.call.op === "free" ? "" : cur.call.ok ? (cur.call.op === "remap" ? (cur.call.moved ? "moved" : "in place") : cur.call.op === "resize" ? "true" : "ok") : cur.call.op === "resize" ? "false" : "null"}
                </span>
              </div>
              {cur.call.backing.map((b, i) => <div key={i} className="muted">↳ {b}</div>)}
            </div>
          )}
          <ButtonRow style={{ marginTop: 6 }}><IndexButtons k={at} n={run.steps.length} set={setK} /></ButtonRow>
          <IndexSlider k={at} n={run.steps.length} set={setK} label="Call" />
        </div>
      </div>
      <SectionLabel>Backing memory after this call</SectionLabel>
      <Regions regions={cur?.regions ?? []} scale={scale} empty="The allocator holds no memory now." />
      <div className="muted" style={{ fontSize: 11.5, marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span><b style={{ color: "var(--c1)" }}>■</b> list a</span><span><b style={{ color: "var(--c5)" }}>■</b> list b</span><span><b style={{ color: "var(--c2)" }}>■</b> report</span><span>hatched: freed, but still taking space</span>
      </div>
      <Stats items={[
        { label: "alloc / remap / free", value: `${run.counts.alloc} / ${run.counts.remap} / ${run.counts.free}` },
        { label: "remaps that said null", value: run.failedRemaps },
        { label: "calls to the layer below", value: run.backingCalls },
        { label: "peak memory held", value: fmtBytes(run.peakHeld) },
        { label: "peak bytes in use", value: fmtBytes(run.peakLive) },
      ]} />
      <Banner tone={verdict.tone}>{verdict.text}</Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- checkAllAllocationFailures

const FAIL = {
  a: toggle({ label: "errdefer gpa.free(name)", default: true }),
  b: toggle({ label: "errdefer gpa.free(email)", default: false }),
  c: toggle({ label: "errdefer tags.deinit(gpa)", default: false }),
  swallow: toggle({ label: "catch {} on append", default: false }),
};

const WHAT = ["name", "email", "tags"] as const;

function cellOf(r: LoadRun, w: (typeof WHAT)[number]): { text: string; color: string } {
  const failed = r.events.some((e) => e.kind === "fail" && e.what === w);
  const allocated = r.events.some((e) => e.kind === "alloc" && e.what === w);
  if (failed) return { text: "null", color: "var(--c2)" };
  if (!allocated) return { text: "–", color: "var(--faint)" };
  if (r.leaked.includes(w)) return { text: "leak", color: "var(--c4)" };
  return { text: "freed", color: "var(--c3)" };
}

export function ZigFailDemo() {
  const P = useParams("sys-exp-fail", FAIL);
  const flags = P.values;
  const res = useMemo(() => checkAll(flags), [flags.a, flags.b, flags.c, flags.swallow]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = useMemo(() => runLoad(flags, null, BAD_EMAIL), [flags.a, flags.b, flags.c, flags.swallow]); // eslint-disable-line react-hooks/exhaustive-deps
  const runs = [...res.runs, bad];
  const [sel, setSel] = useState<number | null>(null);
  const pick = Math.min(sel ?? (res.stoppedAt > 0 ? res.stoppedAt : 1), runs.length - 1);
  const r = runs[pick]!;
  const dim = new Set<number>([...(flags.a ? [] : [ERRDEFER_LINES.a]), ...(flags.b ? [] : [ERRDEFER_LINES.b]), ...(flags.c ? [] : [ERRDEFER_LINES.c])]);
  const source = LOAD_SOURCE.map((l, i) => (i === 7 && flags.swallow ? "    tags.append(gpa, \"new\") catch {};" : l));
  const label = (i: number) => (i === 0 ? "count (no failure)" : i === runs.length - 1 ? `email "${BAD_EMAIL}" (own test)` : `fail_index ${i - 1}`);
  return (
    <Demo
      title="Make every allocation fail, one at a time"
      controls={<>
        <Param spec={FAIL.a} value={flags.a} onChange={(v) => P.set("a", v as boolean)} />
        <Param spec={FAIL.b} value={flags.b} onChange={(v) => P.set("b", v as boolean)} />
        <Param spec={FAIL.c} value={flags.c} onChange={(v) => P.set("c", v as boolean)} />
        <Param spec={FAIL.swallow} value={flags.swallow} onChange={(v) => P.set("swallow", v as boolean)} />
      </>}
    >
      <Code lines={source} dim={dim} bad={new Set(r.events.filter((e) => e.kind === "fail" || e.kind === "error").map((e) => e.line))} />
      <SectionLabel>Runs of checkAllAllocationFailures (click a row)</SectionLabel>
      <div style={{ cursor: "pointer" }}>
        <MiniTable
          head={["run", ...WHAT, "result"]}
          highlight={pick}
          rows={runs.map((x, i) => [
            <span key="l" onClick={() => setSel(i)} style={{ ...mono, fontSize: 12, color: i === res.stoppedAt ? "var(--c4)" : undefined }}>{label(i)}{i === res.stoppedAt ? " ◀ stops" : ""}</span>,
            ...WHAT.map((w) => { const c = cellOf(x, w); return <span key={w} onClick={() => setSel(i)} style={{ color: c.color, ...mono, fontSize: 12 }}>{c.text}</span>; }),
            <span key="r" onClick={() => setSel(i)} style={{ ...mono, fontSize: 12 }}>{x.outcome === "ok" ? (x.induced ? "ok (swallowed)" : "ok") : x.outcome.replace("error.", "")}</span>,
          ])}
        />
      </div>
      <ButtonRow style={{ marginTop: 6 }}><IndexButtons k={pick} n={runs.length} set={(v) => setSel(v)} /></ButtonRow>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 8 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>{label(pick)}: what happened</SectionLabel>
          <div style={{ ...mono, fontSize: 12, display: "grid", gap: 2 }}>
            {r.events.map((e, i) => (
              <div key={i} style={{ padding: "1px 6px", borderRadius: 3, background: e.kind === "fail" || e.kind === "error" ? tint("var(--c4)", 12) : e.kind === "skip" ? tint("var(--c2)", 12) : undefined }}>
                <span className="muted">line {e.line}</span> {e.text}
              </div>
            ))}
            {r.outcome === "ok" && <div className="muted" style={{ padding: "1px 6px" }}>testImpl: u.deinit(gpa) frees all three.</div>}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Heap at the end of this run</SectionLabel>
          <HeapBlocks blocks={r.snapshot.heap} edges={r.snapshot.edges} empty="No blocks: nothing was allocated." />
        </div>
      </div>
      {res.verdict === "pass"
        ? <Banner tone="good">The checker passes: {res.needed} allocations, {res.needed} failure runs, no leak.{bad.leaked.length ? ` But the "${BAD_EMAIL}" test leaks ${bad.leaked.join(", ")}: the checker only makes allocations fail.` : ""}</Banner>
        : <Banner tone="bad"><div style={{ ...mono, fontSize: 12.5, whiteSpace: "pre-wrap" }}>{res.verdict}{"\n"}{res.message.filter((m) => !m.startsWith("error.")).join("\n")}</div></Banner>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Valid email for the checker runs: "{VALID_EMAIL}". The heap is the track's memory model.</div>
    </Demo>
  );
}
