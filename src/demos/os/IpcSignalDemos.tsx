/** Demos for "signals": delivery with masks and the signal frame, a deadlock in a handler, and merging against queueing. */
import { useMemo, useState, type ReactNode } from "react";
import { Demo, Param, Stats, range, select, toggle, useParams, Banner, MONO } from "../../kit";
import {
  FRAME_BYTES_MODEL, HANDLER_LINES, HANDLER_VARIANTS, MAIN_LINES, RESTORER_TEXT, SIG, SIGNAL_FACTS, SignalTask, coalesceRun, handlerAction, handlerProg, sigName, zombiesLeft,
  type HandlerVariant, type SigFrame,
} from "../../sims/os/ipc";
import { explore, machineModel } from "../../sims/os/sync/machine";
import { SyncStepper } from "./SyncShared";

const hex = (n: number) => `0x${n.toString(16)}`;

// ---------------------------------------------------------------- 1. delivery

const DEL = {
  restart: toggle({ label: "SA_RESTART on both handlers", default: false }),
  mask: toggle({ label: "SIGUSR1's sa_mask includes SIGUSR2", default: false }),
};

const WATCHED = [SIG.SIGUSR1, SIG.SIGUSR2, SIG.SIGTERM];

function makeTask(restart: boolean, mask: boolean) {
  const t = new SignalTask();
  t.sigaction(SIG.SIGUSR1, handlerAction({ restart, mask: mask ? [SIG.SIGUSR2] : [] }));
  t.sigaction(SIG.SIGUSR2, handlerAction({ restart }));
  return t;
}

const PHASE_TEXT: Record<SignalTask["phase"], { text: string; kernel: boolean }> = {
  user: { text: "user mode", kernel: false },
  sleeping: { text: "kernel: asleep in read", kernel: true },
  kick: { text: "kernel: return path", kernel: true },
  "syscall-exit": { text: "kernel: return path", kernel: true },
  handler: { text: "user mode: handler", kernel: false },
  restorer: { text: "user mode: return from handler", kernel: false },
  sigreturn: { text: "kernel: rt_sigreturn", kernel: true },
  dead: { text: "dead", kernel: true },
  stopped: { text: "stopped", kernel: true },
  finished: { text: "finished", kernel: false },
};

function CodeLines({ title, lines, active, tail }: { title: string; lines: { text: string }[]; active: number | null; tail?: { text: string; on: boolean } }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>{title}</div>
      {lines.map((l, i) => (
        <div key={i} style={{ fontFamily: MONO, fontSize: 11.5, lineHeight: 1.45, padding: "0 4px", borderRadius: 3, outline: active === i ? "1.5px solid var(--c1)" : "none", outlineOffset: -1, fontWeight: active === i ? 600 : 400, color: active === i ? "var(--fg)" : "var(--muted)", overflowWrap: "anywhere" }}>{l.text}</div>
      ))}
      {tail && <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.45, padding: "0 4px", borderRadius: 3, outline: tail.on ? "1.5px solid var(--c5)" : "none", outlineOffset: -1, color: tail.on ? "var(--fg)" : "var(--muted)", overflowWrap: "anywhere" }}>{tail.text}</div>}
    </div>
  );
}

function FrameBox({ f, index, top }: { f: SigFrame; index: number; top: boolean }) {
  const rows: [string, string][] = [
    ["pretcode", "__restore_rt"],
    ["saved rip", f.savedRip],
    ["saved rsp", hex(f.savedRsp)],
    ["saved rax", f.savedRax],
    ["uc_sigmask", f.savedBlocked.length ? f.savedBlocked.map(sigName).join(" ") : "empty"],
    ["siginfo", `si_signo = ${f.sig}`],
    ["fpstate", "XSAVE area"],
  ];
  return (
    <div style={{ border: `1.5px solid ${top ? "var(--c5)" : "var(--border)"}`, borderRadius: 5, padding: "3px 6px", background: "var(--bg)" }}>
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2 }}>rt_sigframe {index + 1}: {sigName(f.sig)}</div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 6, fontFamily: MONO, fontSize: 10.5, lineHeight: 1.35 }}>
          <span className="muted">{k}</span><span style={{ textAlign: "right", overflowWrap: "anywhere" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

export function IpcSignalDeliveryDemo() {
  const P = useParams("os-ipc-sig", DEL);
  const { restart, mask } = P.values;
  const [hist, setHist] = useState<{ key: string; list: SignalTask[] }>(() => ({ key: "", list: [] }));
  const key = `${restart}/${mask}`;
  const list = hist.key === key && hist.list.length ? hist.list : [makeTask(restart, mask)];
  const t = list[list.length - 1]!;
  const push = (f: (x: SignalTask) => void) => {
    const n = t.clone();
    f(n);
    setHist({ key, list: [...list, n] });
  };
  const phase = PHASE_TEXT[t.phase];
  const inHandler = t.phase === "handler" || t.phase === "restorer" || t.phase === "sigreturn" || (t.frames.length > 0 && t.phase !== "user");
  const mainActive = !inHandler && t.phase !== "dead" ? Math.min(t.pc, MAIN_LINES.length - 1) : null;
  const handlerActive = t.phase === "handler" ? t.hpc : null;
  const canAct = t.phase !== "dead" && t.phase !== "finished";
  const last = t.last;
  const toggleBlock = (s: number) => push((n) => n.sigprocmask(n.blocked.includes(s) ? "unblock" : "block", [s]));
  return (
    <Demo
      title="Signal delivery"
      actions={<>
        <button className="btn" disabled={list.length <= 1} onClick={() => setHist({ key, list: list.slice(0, -1) })}>Back</button>
        <button className="btn ghost" onClick={() => setHist({ key, list: [] })}>Reset</button>
      </>}
      controls={<><Param spec={DEL.restart} value={restart} onChange={(v) => P.set("restart", v as boolean)} /><Param spec={DEL.mask} value={mask} onChange={(v) => P.set("mask", v as boolean)} /></>}
    >
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <button className="btn primary" disabled={!t.canStep()} onClick={() => push((n) => { n.step(); })}>Next step</button>
        <button className="btn" disabled={t.phase !== "sleeping"} onClick={() => push((n) => n.dataArrives())}>Data arrives</button>
        <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: phase.kernel ? "var(--c5)" : "var(--subtle)", color: phase.kernel ? "var(--bg)" : "var(--fg)", border: "1px solid var(--border)" }}>{phase.text}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
          <CodeLines title="main" lines={MAIN_LINES} active={mainActive} />
          <CodeLines title="on_sig (the handler)" lines={HANDLER_LINES} active={handlerActive} tail={{ text: RESTORER_TEXT, on: t.phase === "restorer" || t.phase === "sigreturn" }} />
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0 8px", fontFamily: MONO, fontSize: 11 }}>
            <span className="muted">rip</span><span>{t.rip}</span>
            <span className="muted">rsp</span><span>{hex(t.rsp)}</span>
            <span className="muted">rax</span><span style={{ color: t.rax.startsWith("-") ? "var(--c4)" : "var(--fg)" }}>{t.rax}</span>
            <span className="muted">TIF_SIGPENDING</span><span>{t.sigpendingFlag ? "1" : "0"}</span>
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "4px 6px", alignItems: "center", fontSize: 12 }}>
            <span className="muted" style={{ fontSize: 11 }}>signal</span>
            <span className="muted" style={{ fontSize: 11, textAlign: "center" }}>pending</span>
            <span className="muted" style={{ fontSize: 11, textAlign: "center" }}>blocked</span>
            <span />
            {WATCHED.map((s) => {
              const pend = t.pending.has(s), blocked = t.blocked.includes(s);
              return (
                <Row key={s}>
                  <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{sigName(s)}</span>
                  <Bit on={pend} color="var(--c2)" />
                  <button aria-label={`Toggle block of ${sigName(s)}`} onClick={() => toggleBlock(s)} disabled={!canAct} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", justifySelf: "center" }}><Bit on={blocked} color="var(--c4)" /></button>
                  <button className="btn" style={{ padding: "1px 8px", fontSize: 11.5 }} disabled={!canAct} onClick={() => push((n) => { n.send(s); })}>Send</button>
                </Row>
              );
            })}
          </div>
          <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>Click a blocked bit to call sigprocmask. SIGTERM has no handler here, so its default action applies.</p>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>The user stack (it grows downward)</div>
          <div style={{ display: "grid", gap: 3 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "3px 6px", fontSize: 11, background: "var(--subtle)" }}>frames of main</div>
            {t.frames.map((f, i) => (
              <div key={i} style={{ display: "grid", gap: 3 }}>
                <div style={{ fontSize: 10.5, color: "var(--muted)", padding: "0 6px", border: "1px dashed var(--border)", borderRadius: 5 }}>red zone, {SIGNAL_FACTS.redZoneBytes} bytes, skipped</div>
                <FrameBox f={f} index={i} top={i === t.frames.length - 1} />
              </div>
            ))}
            <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--c1)" }}>← rsp = {hex(t.rsp)}</div>
          </div>
        </div>
      </div>
      <Banner tone={last?.tone === "bad" ? "bad" : last?.tone === "good" ? "good" : "plain"}>{last?.text ?? "Click Next step until read sleeps. Then send SIGUSR1."}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "handlers run", value: t.handled.length },
          { label: "frames on the stack", value: t.frames.length },
          { label: "sends that merged", value: t.pending.merged },
          { label: "read returned", value: t.readReturned ?? "not yet" },
        ]} />
      </div>
      <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 0" }}>The frame size in this view, {FRAME_BYTES_MODEL} bytes, is a model input. The real size depends on the XSAVE area of the CPU.</p>
    </Demo>
  );
}

const Row = ({ children }: { children: ReactNode }) => <>{children}</>;
const Bit = ({ on, color }: { on: boolean; color: string }) => (
  <span style={{ display: "inline-block", width: 26, height: 22, lineHeight: "20px", textAlign: "center", borderRadius: 4, fontFamily: MONO, fontSize: 12, fontWeight: 600, border: `1.5px solid ${on ? color : "var(--border)"}`, background: on ? color : "transparent", color: on ? "var(--bg)" : "var(--muted)", justifySelf: "center" }}>{on ? 1 : 0}</span>
);

// ---------------------------------------------------------------- 2. the deadlock

const LOCK = {
  variant: select({ label: "Program", options: HANDLER_VARIANTS, default: "malloc" as HandlerVariant }),
};

export function IpcSignalDeadlockDemo() {
  const P = useParams("os-ipc-lock", LOCK);
  const variant = P.values.variant as HandlerVariant;
  const prog = useMemo(() => handlerProg(variant), [variant]);
  const res = useMemo(() => explore(machineModel(prog)), [prog]);
  const scripts = [];
  if (res.stuck) scripts.push({ label: "Show the deadlock", schedule: res.stuck.schedule });
  if (res.violation) scripts.push({ label: "Show the corruption", schedule: res.violation.schedule });
  return (
    <SyncStepper
      title="A handler on top of malloc"
      prog={prog}
      scripts={scripts}
      controls={<Param spec={LOCK.variant} value={variant} onChange={(v) => P.set("variant", v as never)} />}
      panel={({ s }) => (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5 }}>
          <span>arena lock: <b style={{ color: s.mem.lock ? "var(--c4)" : "var(--c3)", fontFamily: MONO }}>{s.mem.lock ? "held" : "free"}</b></span>
          {variant === "masked" && <span>signal: <b style={{ fontFamily: MONO }}>{s.mem.blocked ? "blocked" : "not blocked"}</b></span>}
          {variant === "self-pipe" && <span>byte in the pipe: <b style={{ fontFamily: MONO }}>{s.mem.pipe ?? 0}</b></span>}
          <span className="muted">Both flows run on one thread. While the handler runs, main cannot run.</span>
        </div>
      )}
      verdict={({ finished }) => (finished ? { tone: "good", text: "Both flows finished." } : null)}
      footer={
        <div style={{ marginTop: 10 }}>
          <Stats items={[
            { label: "states, for every arrival point", value: res.states },
            { label: "deadlock", value: res.stuck ? `yes: ${res.stuck.schedule.length} steps` : "none" },
            { label: "corrupt heap", value: res.violation ? `yes: ${res.violation.schedule.length} steps` : "none" },
          ]} />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- 3. merging against queueing

const CO = {
  sends: range({ label: "Signals sent", min: 1, max: 16, step: 1, default: 5 }),
  gap: range({ label: "Ticks between sends", min: 1, max: 12, step: 1, default: 3 }),
  handler: range({ label: "Handler time", min: 1, max: 40, step: 1, default: 20, format: (v) => `${v} ticks` }),
  masked: range({ label: "Signal blocked at the start", min: 0, max: 60, step: 2, default: 0, format: (v) => `${v} ticks` }),
  loop: toggle({ label: "SIGCHLD handler: waitpid(WNOHANG) in a loop", default: false }),
};

function Track({ title, run, maxT, note }: { title: string; run: ReturnType<typeof coalesceRun>; maxT: number; note: string }) {
  const W = 340, H = 74, L = 8, R = 8;
  const x = (t: number) => L + (t / maxT) * (W - L - R);
  const starts = run.events.filter((e) => e.kind === "start");
  const ends = run.events.filter((e) => e.kind === "end");
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 12.5, marginBottom: 2 }}>
        <b style={{ fontWeight: 600 }}>{title}</b>
        <span className="muted">{note}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} timeline`} style={{ width: "100%", display: "block" }}>
        <line x1={L} x2={W - R} y1={22} y2={22} stroke="var(--border)" />
        <line x1={L} x2={W - R} y1={56} y2={56} stroke="var(--border)" />
        <text x={L} y={11} fontSize={11} fill="var(--muted)">sends</text>
        <text x={L} y={45} fontSize={11} fill="var(--muted)">handler runs</text>
        {run.events.filter((e) => e.kind === "send" || e.kind === "merged").map((e, i) => (
          e.kind === "send"
            ? <circle key={i} cx={x(e.tick)} cy={22} r={5} fill="var(--c1)"><title>{`send ${e.value}: entered the pending set`}</title></circle>
            : <g key={i}><circle cx={x(e.tick)} cy={22} r={5} fill="var(--bg)" stroke="var(--c4)" strokeWidth={1.5} /><line x1={x(e.tick) - 3} y1={19} x2={x(e.tick) + 3} y2={25} stroke="var(--c4)" strokeWidth={1.5} /><title>{`send ${e.value}: merged`}</title></g>
        ))}
        {starts.map((e, i) => {
          const end = ends[i]?.tick ?? e.tick + spacing(run);
          return <g key={i}><rect x={x(e.tick)} y={49} width={Math.max(2, x(end) - x(e.tick) - 1.5)} height={14} rx={2} fill="var(--c3)" /><text x={x(e.tick) + 3} y={60} fontSize={10} fill="var(--bg)">{x(end) - x(e.tick) > 12 ? e.value : ""}</text></g>;
        })}
      </svg>
    </div>
  );
}
const spacing = (run: ReturnType<typeof coalesceRun>) => Math.max(1, run.ticks / 20);

export function IpcSignalCoalesceDemo() {
  const P = useParams("os-ipc-co", CO);
  const { sends, gap, handler, masked, loop } = P.values;
  const spec = { sends, gap, handlerTicks: handler, maskedTicks: masked };
  const std = useMemo(() => coalesceRun({ sig: SIG.SIGCHLD, ...spec }), [sends, gap, handler, masked]); // eslint-disable-line react-hooks/exhaustive-deps
  const rt = useMemo(() => coalesceRun({ sig: SIGNAL_FACTS.glibcSigRtMin, ...spec }), [sends, gap, handler, masked]); // eslint-disable-line react-hooks/exhaustive-deps
  const maxT = Math.max(std.ticks, rt.ticks, 1);
  return (
    <Demo title="Standard signals merge. Real-time signals queue." controls={<>
      <Param spec={CO.sends} value={sends} onChange={(v) => P.set("sends", v as number)} />
      <Param spec={CO.gap} value={gap} onChange={(v) => P.set("gap", v as number)} />
      <Param spec={CO.handler} value={handler} onChange={(v) => P.set("handler", v as number)} />
      <Param spec={CO.masked} value={masked} onChange={(v) => P.set("masked", v as number)} />
      <Param spec={CO.loop} value={loop} onChange={(v) => P.set("loop", v as boolean)} />
    </>}>
      <div style={{ display: "grid", gap: 10 }}>
        <Track title="SIGCHLD (standard)" run={std} maxT={maxT} note={`${std.handlerRuns} handler runs, ${std.merged} sends merged`} />
        <Track title="SIGRTMIN (real-time)" run={rt} maxT={maxT} note={`${rt.handlerRuns} handler runs, each with its own value`} />
      </div>
      <p className="muted" style={{ fontSize: 11.5, margin: "4px 0 8px" }}>A filled dot enters the pending set. A crossed dot merges with a bit that is already set. The numbers on the bars are the values that the handler sees.</p>
      <Stats items={[
        { label: "children that exited", value: sends },
        { label: "SIGCHLD handler runs", value: std.handlerRuns },
        { label: "zombies left", value: zombiesLeft(sends, std.handlerRuns, loop) },
      ]} />
    </Demo>
  );
}
