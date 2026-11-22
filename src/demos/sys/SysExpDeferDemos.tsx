/** Demos for "defer and errdefer": pick the error path and watch the cleanups; a defer inside a loop. */
import { useMemo } from "react";
import { Banner, ButtonRow, Demo, Legend, Line, Param, Plot, RuleY, SectionLabel, StepButtons, StepCaption, StepSlider, Stats, range, seg, select, useParams, useStepper } from "../../kit";
import { BUGS, FAIL_POINTS, GO_LINUX_POLLER_FDS, LOOP_SOURCE, STD_FDS, deferSource, loopFds, runDefer, type Bug, type FailAt, type Lang, type LoopVariant, type Platform } from "../../sims/sys/explicit";
import { HeapBlocks, UbBanner } from "./SysViews";
import { CleanupStack, Code } from "./SysExpUi";

const DS = {
  lang: seg<Lang>("Language", [["zig", "Zig"], ["goto", "C goto"], ["cleanup", "C cleanup attr"]], "zig"),
  fail: select<FailAt>({ label: "What fails", options: FAIL_POINTS.map((f) => ({ value: f.id, label: f.label })), default: "check" }),
  bug: select<Bug>({ label: "Version", options: [...BUGS.zig, ...BUGS.goto.slice(1), ...BUGS.cleanup.slice(1)].map((b) => ({ value: b.id, label: b.label })), default: "none" }),
};

export function CleanupPathDemo() {
  const P = useParams("sys-exp-defer", DS);
  const { lang, fail } = P.values;
  const bug = BUGS[lang].some((b) => b.id === P.values.bug) ? P.values.bug : "none";
  const bugSpec = select<Bug>({ label: "Version", options: BUGS[lang].map((b) => ({ value: b.id, label: b.label })), default: "none" });
  const run = useMemo(() => runDefer(lang, fail, bug), [lang, fail, bug]);
  const s = useStepper(run.steps.length, 1.2);
  const cur = run.steps[s.i]!;
  const src = deferSource(lang, bug);
  const ubSoFar = cur.snap.ub;
  return (
    <Demo
      title="Choose the error path, watch the cleanups"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={DS.lang} value={lang} onChange={(v) => { P.set("lang", v as Lang); P.set("bug", "none" as Bug); s.reset(); }} />
        <Param spec={DS.fail} value={fail} onChange={(v) => { P.set("fail", v as FailAt); s.reset(); }} />
        <Param spec={bugSpec} value={bug} onChange={(v) => { P.set("bug", v as Bug); s.reset(); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>{cur.where === "load" ? "Inside load" : cur.where === "caller" ? "In the caller" : "At exit"}</SectionLabel>
          <Code lines={src} current={cur.where === "load" ? cur.line : undefined} />
          {lang === "cleanup" && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>CLEANUP(fn) is __attribute__((cleanup(fn))).</div>}
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Pending cleanups (newest on top)</SectionLabel>
          {lang === "goto"
            ? <div className="muted" style={{ fontSize: 12.5 }}>C has no cleanup stack. The labels at the end of the function are the stack, written by hand.</div>
            : <CleanupStack pending={cur.pending} ran={cur.ran} />}
          <SectionLabel>Heap</SectionLabel>
          <HeapBlocks blocks={cur.snap.heap} edges={cur.snap.edges} empty="Nothing allocated." />
        </div>
      </div>
      <StepCaption label={cur.where === "load" && cur.line ? `line ${cur.line}` : cur.where} tone={cur.ub.length ? "bad" : cur.ran?.length ? "info" : null}>{cur.caption}</StepCaption>
      {cur.ub.map((r, i) => <UbBanner key={i} event={r} />)}
      {s.atEnd && !cur.ub.length && <Banner tone={ubSoFar.length ? "bad" : "good"}>{ubSoFar.length ? `This path has ${ubSoFar.length} memory error${ubSoFar.length > 1 ? "s" : ""}: ${[...new Set(ubSoFar.map((u) => u.kind))].join(", ")}. Step back to see where.` : `load ${run.ok ? "succeeded" : "failed"}, and every resource was released exactly once.`}</Banner>}
    </Demo>
  );
}

// ---------------------------------------------------------------- defer in a loop

const LP = {
  files: range({ label: "Files to process", min: 10, max: 5000, step: 10, default: 2000, log: true }),
  platform: seg<Platform>("Platform", [["macos", "macOS"], ["linux", "Linux"]], "macos"),
  limit: select({ label: "Open-file limit (soft = hard)", options: [{ value: "256", label: "256" }, { value: "1024", label: "1024" }, { value: "65536", label: "65536" }], default: "1024", segmented: true }),
  variant: seg<LoopVariant>("Code", [["go-loop", "Go: defer in loop"], ["go-func", "Go: func literal"], ["zig-block", "Zig: block defer"]], "go-loop"),
};

export function DeferLoopDemo() {
  const P = useParams("sys-exp-loop", LP);
  const { files, variant } = P.values;
  const limit = Number(P.values.limit);
  const platform = P.values.platform;
  const runs = useMemo(() => ({
    "go-loop": loopFds(files, limit, "go-loop", platform), "go-func": loopFds(files, limit, "go-func", platform), "zig-block": loopFds(files, limit, "zig-block", platform),
  }), [files, limit, platform]);
  const base = STD_FDS + (platform === "linux" && variant !== "zig-block" ? GO_LINUX_POLLER_FDS : 0);
  const r = runs[variant];
  const step = Math.max(1, Math.floor(files / 200));
  const pts = (v: LoopVariant) => runs[v].open.filter((_, i) => i % step === 0 || i === runs[v].open.length - 1).map((y, i0) => [Math.min(files, i0 * step + 1), y] as [number, number]);
  const ymax = Math.min(limit, files + base) * 1.08;
  const src = LOOP_SOURCE[variant];
  return (
    <Demo title="defer inside a loop" controls={<>
      <Param spec={LP.files} value={files} onChange={(v) => P.set("files", v as number)} />
      <Param spec={LP.limit} value={P.values.limit} onChange={(v) => P.set("limit", v as never)} />
      <Param spec={LP.platform} value={platform} onChange={(v) => P.set("platform", v as Platform)} />
      <Param spec={LP.variant} value={variant} onChange={(v) => P.set("variant", v as LoopVariant)} />
    </>}>
      <Code lines={src.lines} />
      <Plot x={[1, files]} y={[0, ymax]} height={200} xLabel="file number" yLabel="open descriptors" logY={false}>
        {limit <= ymax && <RuleY at={limit} color="var(--c4)" label="limit" />}
        <Line points={pts("go-loop")} color="var(--c4)" width={variant === "go-loop" ? 2.5 : 1} />
        <Line points={pts("zig-block")} color="var(--c3)" width={variant !== "go-loop" ? 2.5 : 1} />
      </Plot>
      <Legend items={[{ label: "Go: defer in the loop", color: "var(--c4)" }, { label: "Go func literal, Zig block: one file at a time", color: "var(--c3)" }]} />
      <Stats items={[
        { label: "peak open descriptors", value: r.peak },
        { label: "deferred calls waiting at the peak", value: r.pendingAtPeak },
        { label: "result", value: r.failedAt ? `open #${r.failedAt}: too many open files` : `all ${files} files done` },
      ]} />
      {r.failedAt && <Banner tone="bad">File {r.failedAt} cannot open: {limit} descriptors are in use ({base === STD_FDS ? "3 for stdin, stdout and stderr" : "3 for stdin, stdout and stderr, 2 for Go's netpoller"}). The deferred Close calls would run only when the function returns.</Banner>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>The limit here is the soft limit with soft = hard. A Go program raises its soft limit to one below the hard limit at start, so with a larger hard limit it opens many more files.</div>
    </Demo>
  );
}
