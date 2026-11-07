/** Demos for "Deterministic simulation testing": a seed-by-seed fuzzer with coverage, and a bug hunt with shrinking. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Demo, Stats, Banner, Note, SmallLabel, SectionLabel, Param, seg, toggle, mono, Btn, ButtonRow, pct } from "../../kit";
import { SpaceTime } from "./SpaceTime";
import { storeMessages, storeMarks, storeRows, faultBars, Verdict } from "./CapstoneUi";
import {
  Campaign, FUZZ_DEFAULT, FAULT_KINDS, bugConfig, genSchedule, runSim, shrink, faultText,
  type FuzzConfig, type RunResult, type BugId, type Fault, type ReadMode, type ShrinkStep,
} from "../../sims/dist/capstone";

const BUGS: { id: BugId; label: string; what: string; fix: string }[] = [
  { id: "followerRead", label: "read from any server", what: "a get goes to a random server, which answers from its own state machine", fix: "Serve reads on the leader after ReadIndex (or under a valid lease), or let a follower ask the leader for the read index first." },
  { id: "forgetVote", label: "votedFor not on disk", what: "a server forgets whom it voted for when it restarts, so it can vote twice in one term", fix: "Write currentTerm and votedFor to disk, and fsync, before the vote reply leaves." },
  { id: "oldTermCommit", label: "commit older terms", what: "a leader counts replicas of entries from older terms (Raft Figure 8); the no-op at election is off, because it would hide the bug", fix: "Commit by counting only entries of the current term; older entries commit with them. Append a no-op at the start of each term." },
  { id: "noDedup", label: "no session dedup", what: "writes carry no session tag, so a retry after a lost reply applies a second time", fix: "Tag each write with (client, seq), keep the last result per client in the state machine and in snapshots, and answer a retry from the table." },
];

// ============================================================================
// The fuzzer
// ============================================================================

const EVENTS: { k: keyof Campaign["s"]["totals"]; label: string }[] = [
  { k: "elections", label: "elections" },
  { k: "leaderHits", label: "faults that hit the leader" },
  { k: "truncations", label: "log truncations" },
  { k: "retries", label: "client retries" },
  { k: "dupSuppressed", label: "duplicates stopped by sessions" },
  { k: "readIndexRounds", label: "ReadIndex rounds" },
  { k: "leaseReads", label: "lease reads" },
];

export function SimFuzzerDemo() {
  const [mode, setMode] = useState<Exclude<ReadMode, "local">>("readindex");
  const [swarm, setSwarm] = useState(true);
  const [servers, setServers] = useState<"3" | "5">("3");
  const cfg: FuzzConfig = useMemo(() => ({ ...FUZZ_DEFAULT, readMode: mode, swarm, servers: Number(servers) }), [mode, swarm, servers]);
  const camp = useRef(new Campaign(cfg));
  const [running, setRunning] = useState(false);
  const [, force] = useState(0);
  const [replay, setReplay] = useState<{ seed: number; a: string; b: string } | null>(null);
  const last = useRef<RunResult | null>(null);
  useEffect(() => { camp.current = new Campaign(cfg); last.current = null; setReplay(null); setRunning(false); force((x) => x + 1); }, [cfg]);
  useEffect(() => {
    if (!running) return;
    let live = true;
    const tick = () => {
      if (!live) return;
      const c = camp.current, t0 = performance.now();
      while (performance.now() - t0 < 25 && !c.s.firstFail && c.s.runs < 5000) {
        const seed = c.next++;
        const r = runSim(seed, genSchedule(seed, c.cfg), c.cfg).result;
        c.add(r);
        last.current = r;
      }
      force((n) => n + 1);
      if (c.s.firstFail || c.s.runs >= 5000) { setRunning(false); return; }
      setTimeout(tick, 16);
    };
    const id = setTimeout(tick, 0);
    return () => { live = false; clearTimeout(id); };
  }, [running]);
  const s = camp.current.s;
  const maxFault = Math.max(1, ...Object.values(s.faults).map((v) => v ?? 0));
  const doReplay = () => {
    const r = last.current;
    if (!r) return;
    const again = runSim(r.seed, r.schedule, camp.current.cfg).result;
    setReplay({ seed: r.seed, a: r.fingerprint, b: again.fingerprint });
  };
  return (
    <Demo
      title="Simulation fuzzer"
      actions={
        <>
          <button className="btn primary" onClick={() => setRunning(!running)}>{running ? "Pause" : s.runs ? "Continue" : "Run"}</button>
          <button className="btn" onClick={doReplay} disabled={running || !last.current}>Replay last seed</button>
          <button className="btn ghost" onClick={() => { camp.current = new Campaign(cfg); last.current = null; setReplay(null); setRunning(false); force((x) => x + 1); }}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={seg<Exclude<ReadMode, "local">>("Read path", [["readindex", "ReadIndex"], ["lease", "lease"], ["log", "log"]], "readindex")} value={mode} onChange={(v) => setMode(v as Exclude<ReadMode, "local">)} />
          <Param spec={seg<"3" | "5">("Servers", [["3", "3"], ["5", "5"]], "3")} value={servers} onChange={(v) => setServers(v as "3" | "5")} />
          <Param spec={toggle({ label: "Swarm testing: each seed uses a random subset of fault kinds and load", default: true })} value={swarm} onChange={(v) => setSwarm(v as boolean)} />
        </>
      }
    >
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>
        Each seed is one run: {cfg.servers} servers, {cfg.clients} clients, 2 to 7 random faults in the first {cfg.faultEnd} ms, then a heal and a quiet period. After each run the exact linearizability checker reads the history, and the Raft safety monitor reports any broken property.
      </p>
      <Stats items={[
        { label: "seeds run", value: s.runs.toLocaleString("en-US") },
        { label: "operations checked", value: s.ops.toLocaleString("en-US") },
        { label: "runs passed", value: s.runs ? pct(s.passed / s.runs, 1) : "–" },
        { label: "failures", value: s.firstFail ? 1 : 0 },
      ]} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8 }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <SmallLabel>Fault kinds injected</SmallLabel>
          {FAULT_KINDS.filter((f) => f.id !== "skew").map((f) => {
            const n = s.faults[f.id] ?? 0;
            return (
              <div key={f.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) 40px", gap: 6, alignItems: "center", fontSize: 12, margin: "2px 0" }}>
                <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.label}</span>
                <div style={{ height: 9, background: "var(--subtle)", borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${(100 * n) / maxFault}%`, height: "100%", background: "var(--c1)" }} /></div>
                <span style={{ ...mono, textAlign: "right" }}>{n}</span>
              </div>
            );
          })}
        </div>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <SmallLabel>States the runs reached</SmallLabel>
          {EVENTS.map((e) => (
            <div key={e.k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, margin: "2px 0", gap: 8 }}>
              <span className="muted">{e.label}</span>
              <b style={mono}>{s.totals[e.k].toLocaleString("en-US")}</b>
            </div>
          ))}
        </div>
      </div>
      {last.current && (
        <Banner tone={last.current.ok ? "good" : "bad"} label={`seed ${last.current.seed}`}>
          {last.current.schedule.length} faults, {last.current.ops} operations, fingerprint <span style={mono}>{last.current.fingerprint}</span>.
          {replay && <> Replayed seed {replay.seed}: <span style={mono}>{replay.b}</span> <Verdict ok={replay.a === replay.b}>{replay.a === replay.b ? "same run" : "different"}</Verdict></>}
        </Banner>
      )}
      {s.firstFail && <Banner ok={false}>Seed {s.firstFail.seed} fails: {s.firstFail.failure?.text}</Banner>}
      <Note>The fingerprint hashes every send, delivery, loss, timer and operation of the run. One seed and one schedule always give the same fingerprint, so any failure can be replayed exactly.</Note>
    </Demo>
  );
}

// ============================================================================
// Break it: find, shrink, replay
// ============================================================================

type Phase = "idle" | "hunt" | "shrink" | "done" | "none";

interface Hunt { seed: number; runs: number; first: RunResult | null; steps: ShrinkStep | null; minimal: Fault[] | null; result: RunResult | null }

export function BreakItDemo() {
  const [bug, setBug] = useState<BugId>("followerRead");
  const [phase, setPhase] = useState<Phase>("idle");
  const [withBug, setWithBug] = useState(true);
  const [, force] = useState(0);
  const cfg = useMemo(() => bugConfig(bug), [bug]);
  const hunt = useRef<Hunt>({ seed: 1, runs: 0, first: null, steps: null, minimal: null, result: null });
  const gen = useRef<Generator<ShrinkStep, { schedule: Fault[]; tries: number; result: RunResult }> | null>(null);
  const limit = 2000;
  useEffect(() => { hunt.current = { seed: 1, runs: 0, first: null, steps: null, minimal: null, result: null }; gen.current = null; setPhase("idle"); setWithBug(true); }, [bug]);
  useEffect(() => {
    if (phase !== "hunt" && phase !== "shrink") return;
    let live = true;
    const tick = () => {
      if (!live) return;
      const h = hunt.current, t0 = performance.now();
      if (phase === "hunt") {
        while (performance.now() - t0 < 25 && h.runs < limit) {
          const seed = h.seed++;
          h.runs++;
          const r = runSim(seed, genSchedule(seed, cfg), cfg).result;
          if (!r.ok) {
            h.first = r;
            gen.current = shrink(r.seed, r.schedule, cfg);
            setPhase("shrink");
            return;
          }
        }
        force((n) => n + 1);
        if (h.runs >= limit) return void setPhase("none");
      } else {
        while (performance.now() - t0 < 25) {
          const r = gen.current!.next();
          if (r.done) {
            h.minimal = r.value.schedule;
            h.result = r.value.result;
            setPhase("done");
            return;
          }
          h.steps = r.value;
        }
        force((n) => n + 1);
      }
      setTimeout(tick, 16);
    };
    const id = setTimeout(tick, 0);
    return () => { live = false; clearTimeout(id); };
  }, [phase, cfg]);
  const h = hunt.current;
  const info = BUGS.find((b) => b.id === bug)!;
  const view = useMemo(() => {
    if (phase !== "done" || !h.minimal || !h.first) return null;
    const run = runSim(h.first.seed, h.minimal, withBug ? cfg : { ...cfg, bugs: {} });
    const s = run.store;
    const f = h.result!.failure!;
    let t0: number, t1: number;
    const bad = new Set(f.ops);
    if (f.kind === "linearizability" && f.ops.length) {
      const recs = s.ops.filter((o) => bad.has(o.id));
      t1 = Math.max(...recs.map((o) => (Number.isFinite(o.ret) ? o.ret : o.call + 50))) + 15;
      t0 = Math.max(0, Math.min(...recs.map((o) => o.call)) - 160);
    } else {
      t1 = f.t + 25;
      t0 = Math.max(0, f.t - 260);
    }
    return { s, t0, t1, ok: run.result.ok, text: run.result.failure?.text, messages: storeMessages(s, t0, t1, { clientLabels: false }), marks: [...faultBars(s, t0, t1), ...storeMarks(s, t0, t1, withBug ? bad : undefined)] };
  }, [phase, withBug, cfg, h.minimal, h.first, h.result]);
  return (
    <Demo
      title="Break it: find, shrink and replay"
      actions={
        <>
          <button className="btn primary" onClick={() => setPhase("hunt")} disabled={phase !== "idle"}>Hunt</button>
          <button className="btn ghost" onClick={() => { hunt.current = { seed: 1, runs: 0, first: null, steps: null, minimal: null, result: null }; setPhase("idle"); setWithBug(true); }}>Reset</button>
        </>
      }
      controls={<Param spec={seg<BugId>("Bug", BUGS.map((b) => [b.id, b.label] as [BugId, string]), "followerRead")} value={bug} onChange={(v) => setBug(v as BugId)} />}
    >
      <p style={{ fontSize: 13, margin: "0 0 8px" }}><b>The bug:</b> {info.what}.{bug === "oldTermCommit" ? " Its hunt uses only the three targeted faults that build the Figure 8 order." : ""}</p>
      <Stats items={[
        { label: "seeds tried", value: h.runs },
        { label: "failing seed", value: h.first ? h.first.seed : "–" },
        { label: "faults: found → minimal", value: h.first ? `${h.first.schedule.length} → ${h.minimal ? h.minimal.length : h.steps ? h.steps.faults : "…"}` : "–" },
        { label: "shrink replays", value: h.minimal ? h.steps?.tries ?? 0 : h.steps?.tries ?? "–" },
      ]} />
      {phase === "idle" && <Banner tone="plain">Press Hunt. The fuzzer runs seed 1, 2, 3, … until the checkers report a failure.</Banner>}
      {phase === "none" && <Banner tone="warn">No failure in {limit} seeds.</Banner>}
      {h.first && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <SmallLabel>Schedule of seed {h.first.seed} as found</SmallLabel>
            <ScheduleList faults={h.first.schedule} keep={h.minimal} />
          </div>
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <SmallLabel>Minimal schedule (removing any one fault makes the failure go away)</SmallLabel>
            {h.minimal ? <ScheduleList faults={h.minimal} /> : <div className="muted" style={{ fontSize: 12 }}>shrinking…</div>}
          </div>
        </div>
      )}
      {view && (
        <>
          <SectionLabel>Replay of the minimal schedule, around the failure</SectionLabel>
          <ButtonRow>
            <Btn on={withBug} onClick={() => setWithBug(true)}>with the bug</Btn>
            <Btn on={!withBug} onClick={() => setWithBug(false)}>same seed, bug fixed</Btn>
          </ButtonRow>
          <SpaceTime nodes={storeRows(view.s)} tStart={view.t0} tEnd={view.t1} messages={view.messages} marks={view.marks} rowHeight={36} />
          <Banner ok={view.ok}>{view.ok ? "This run passes both checkers." : `${view.text}.`}</Banner>
          {withBug && <Banner tone="info" label="Fix">{info.fix}</Banner>}
        </>
      )}
      <Note>Shrinking keeps the seed. It drops one fault at a time, then halves fault lengths, and keeps each change after which the run still fails in the same way. Heartbeats are hidden in the diagram; red bars are operations the checker could not place.</Note>
    </Demo>
  );
}

function ScheduleList({ faults, keep }: { faults: Fault[]; keep?: Fault[] | null }) {
  const kept = (f: Fault) => !keep || keep.some((g) => g.kind === f.kind && g.at === f.at);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}>
      {faults.length === 0 && <div className="muted" style={{ padding: "3px 6px" }}>no faults at all</div>}
      {faults.map((f, i) => (
        <div key={i} style={{ padding: "2px 6px", borderBottom: i < faults.length - 1 ? "1px solid var(--border)" : undefined, color: kept(f) ? "var(--fg)" : "var(--faint)", textDecoration: kept(f) ? undefined : "line-through" }}>{faultText(f)}</div>
      ))}
    </div>
  );
}
