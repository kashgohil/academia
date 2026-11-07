/** Demos for "A Raft key-value store, end to end": a playground, and a fault panel with a linearizability check. */
import { useMemo, useState } from "react";
import { Demo, Stats, Banner, Note, SmallLabel, SectionLabel, Btn, ButtonRow, Panel, Param, mono, seg, fixed, Chip } from "../../kit";
import { LogGrid } from "./ConsensusRaftUi";
import { SpaceTime } from "./SpaceTime";
import { storeNode, storeMessages, storeMarks, storeRows, useLiveStore, OpList, Verdict, sname } from "./CapstoneUi";
import { KvStore, attachWorkload, type ReadMode, type OpKind } from "../../sims/dist/capstone";
import type { LinResult } from "../../sims/dist/consistency";

const KEYS = ["x", "y", "z"];
const ROLE_COLOR: Record<string, string> = { leader: "var(--c1)", candidate: "var(--c2)", precandidate: "var(--c2)", follower: "var(--muted)" };

// ============================================================================
// Playground
// ============================================================================

type PlayRead = Exclude<ReadMode, "local">;

function makePlayground(readMode: PlayRead) {
  const s = new KvStore({ servers: 5, voters: [0, 1, 2], clients: 2, seed: 11, readMode, raft: { snapshotThreshold: 0 } });
  s.settle();
  return s;
}

export function KvPlaygroundDemo() {
  const [readMode, setReadMode] = useState<PlayRead>("readindex");
  const live = useLiveStore(() => makePlayground(readMode), 120);
  const { s } = live;
  const [op, setOp] = useState<OpKind>("put");
  const [key, setKey] = useState("x");
  const [value, setValue] = useState(5);
  const [expect, setExpect] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const nodes = s.cluster.nodes.map((_, i) => storeNode(s, i));
  const L = s.leader();
  const cfg = L !== null ? s.node(L).config : s.node(0).config;
  const members = new Set([...cfg.voters, ...cfg.learners]);
  const send = (client: number) => live.act((st) => {
    st.clients[client]!.submit(op === "get" ? { kind: "get", key } : op === "del" ? { kind: "del", key } : op === "cas" ? { kind: "cas", key, expect, value } : { kind: "put", key, value });
    if (!live.playing) live.setPlaying(true);
    if (op !== "get" && op !== "del") setValue((v) => v + 1);
  });
  const lastOps = s.ops.slice(-8);
  const pickNext = (i: number) => {
    if (L === null) return setMsg("No leader right now. Run the cluster until one is elected.");
    const isVoter = cfg.voters.includes(i), isLearner = cfg.learners.includes(i);
    const r = isVoter ? s.changeConfig(cfg.voters.filter((x) => x !== i), cfg.learners)
      : isLearner ? s.changeConfig([...cfg.voters, i], cfg.learners.filter((x) => x !== i))
      : s.changeConfig(cfg.voters, [...cfg.learners, i]);
    setMsg(r.ok ? `${sname(i)}: ${isVoter ? "removed" : isLearner ? "promoted to voter" : "added as a learner"} (configuration entry ${r.index}).` : `Refused: ${r.reason}.`);
    live.act(() => {});
  };
  return (
    <Demo
      title="Key-value store playground"
      actions={
        <>
          <button className="btn primary" onClick={live.toggle}>{live.playing ? "Pause" : "Run"}</button>
          <button className="btn" onClick={() => live.act((st) => st.run(50))} disabled={live.playing}>+50 ms</button>
          <button className="btn ghost" onClick={() => { live.reset(); setMsg(null); }}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={seg<OpKind>("Operation", [["put", "put"], ["get", "get"], ["cas", "cas"], ["del", "del"]], "put")} value={op} onChange={(v) => setOp(v as OpKind)} />
          <Param spec={seg("Key", KEYS.map((k) => [k, k] as [string, string]), "x")} value={key} onChange={(v) => setKey(v as string)} />
          <Param spec={seg<PlayRead>("Read path (resets)", [["readindex", "ReadIndex"], ["lease", "lease"], ["log", "log"]], "readindex")} value={readMode} onChange={(v) => { setReadMode(v as PlayRead); setTimeout(() => live.reset(), 0); }} />
        </>
      }
    >
      <ButtonRow>
        {(op === "put" || op === "cas") && (
          <label style={{ fontSize: 13, display: "flex", gap: 4, alignItems: "center" }}>value
            <input type="number" value={value} min={1} max={999} onChange={(e) => setValue(Math.max(1, Math.min(999, Number(e.target.value) || 1)))} style={{ width: 56, ...mono }} />
          </label>
        )}
        {op === "cas" && (
          <label style={{ fontSize: 13, display: "flex", gap: 4, alignItems: "center" }}>expect
            <input type="number" value={expect} min={0} max={999} onChange={(e) => setExpect(Math.max(0, Math.min(999, Number(e.target.value) || 0)))} style={{ width: 56, ...mono }} />
          </label>
        )}
        <Btn onClick={() => send(0)}>Send as C1</Btn>
        <Btn onClick={() => send(1)}>Send as C2</Btn>
        <span className="muted" style={{ fontSize: 12 }}>{op === "cas" ? "expect 0 means: only if absent" : op === "del" ? "a delete writes 0 (absent)" : ""}</span>
      </ButtonRow>
      <SectionLabel>Servers at {Math.round(s.now)} ms</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
        {nodes.map((n) => {
          const up = n.up, member = members.has(n.id);
          const m = s.machine(n.id);
          const lease = n.role === "leader" && readMode === "lease" ? s.leaseEnd(n.id) : null;
          return (
            <Panel key={n.id} active={n.role === "leader" && up} accent={up ? ROLE_COLOR[n.role] : "var(--faint)"} title={<span>{sname(n.id)} · {up ? n.role : "down"} · t{n.term}{!member ? " · not a member" : cfg.learners.includes(n.id) ? " · learner" : ""}</span>}>
              <div style={{ ...mono, fontSize: 12, opacity: up ? 1 : 0.5 }}>
                {KEYS.map((k) => <span key={k} style={{ marginRight: 8 }}>{k}={m.get(k)}</span>)}
                <div className="muted">commit {n.commitIndex} · applied {n.lastApplied}{n.base ? ` · snap ${n.base}` : ""}</div>
                {lease !== null && <div className="muted">lease {Math.max(0, Math.round(lease - s.localTime(n.id)))} ms left</div>}
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 5 }}>
                <Chip color="var(--c4)" onClick={() => live.act((st) => (up ? st.crash(n.id) : st.recover(n.id)))}>{up ? "crash" : "recover"}</Chip>
                {up && n.lastApplied > n.base && <Chip color="var(--c5)" onClick={() => live.act((st) => st.snapshotNow(n.id))}>snapshot</Chip>}
                {n.role !== "leader" && <Chip color="var(--c1)" onClick={() => pickNext(n.id)}>{cfg.voters.includes(n.id) ? "remove" : cfg.learners.includes(n.id) ? "promote" : "add"}</Chip>}
              </div>
            </Panel>
          );
        })}
      </div>
      {msg && <Banner tone="info">{msg}</Banner>}
      <SectionLabel>Logs (solid: committed on that server; grey: in its snapshot)</SectionLabel>
      <LogGrid nodes={nodes} />
      <SectionLabel>Last operations</SectionLabel>
      <OpList ops={lastOps} max={150} />
      <Note>Five servers, three of them voters at the start. A write goes to the leader, waits for a majority, and applies; the client's session tag (client, seq) makes a retry safe. Use add, promote and remove for membership changes: one voter at a time.</Note>
    </Demo>
  );
}

// ============================================================================
// Fault panel
// ============================================================================

type PanelRead = ReadMode;
const WINDOW = 400;

function makePanel(readMode: PanelRead, seed: number) {
  const s = new KvStore({ servers: 3, clients: 3, seed, readMode, latency: { min: 5, max: 15 } });
  s.settle();
  attachWorkload(s, seed, ["x", "y"], { min: 20, max: 60 });
  return s;
}

export function FaultPanelDemo() {
  const [readMode, setReadMode] = useState<PanelRead>("readindex");
  const [seed, setSeed] = useState(1);
  const live = useLiveStore(() => makePanel(readMode, seed), 160);
  const { s } = live;
  const [verdict, setVerdict] = useState<{ at: number; ops: number; r: LinResult } | null>(null);
  const [drop, setDrop] = useState(false);
  const L = s.leader();
  const followers = [0, 1, 2].filter((i) => i !== L);
  const cuts = s.activeCuts();
  const pausedNow = [...s.paused.keys()];
  const down = [0, 1, 2].filter((i) => !s.isUp(i));
  const restart = () => { setVerdict(null); setDrop(false); setTimeout(() => live.reset(), 0); };
  const t1 = s.now, t0 = Math.max(0, t1 - WINDOW);
  const bad = useMemo(() => new Set(verdict && verdict.r.ok === false ? verdict.r.blocked : []), [verdict]);
  const st = useMemo(() => ({ messages: storeMessages(s, t0, t1, { clientLabels: false }), marks: storeMarks(s, t0, t1, bad) }), [s, t0, t1, bad, live.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = s.ops.filter((o) => Number.isFinite(o.ret)).length;
  const check = () => live.act((x) => { live.setPlaying(false); setVerdict({ at: x.now, ops: x.ops.length, r: x.check(300000) }); });
  return (
    <Demo
      title="Fault panel with a linearizability check"
      actions={
        <>
          <button className="btn primary" onClick={live.toggle}>{live.playing ? "Pause" : "Run"}</button>
          <button className="btn" onClick={check}>Check linearizability</button>
          <button className="btn ghost" onClick={() => restart()}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={seg<PanelRead>("Read path (resets)", [["readindex", "ReadIndex"], ["lease", "lease"], ["log", "log"], ["local", "any server (bug)"]], "readindex")} value={readMode} onChange={(v) => { setReadMode(v as PanelRead); restart(); }} />
          <Param spec={seg("Seed (resets)", [["1", "1"], ["2", "2"], ["3", "3"]], "1")} value={String(seed)} onChange={(v) => { setSeed(Number(v)); restart(); }} />
        </>
      }
    >
      <SmallLabel>Faults (the leader now: {L === null ? "none" : sname(L)})</SmallLabel>
      <ButtonRow>
        <Btn onClick={() => live.act((x) => L !== null && x.crash(L))} disabled={L === null}>crash the leader</Btn>
        <Btn onClick={() => live.act((x) => x.crash(followers[0]!))} disabled={!s.isUp(followers[0]!)}>crash {sname(followers[0]!)}</Btn>
        <Btn onClick={() => live.act((x) => L !== null && x.addCut([L]))} disabled={L === null}>cut off the leader</Btn>
        <Btn onClick={() => live.act((x) => L !== null && x.pause(L))} disabled={L === null}>pause the leader</Btn>
        <Btn on={drop} onClick={() => live.act((x) => { x.setDropRate(drop ? 0 : 0.3); setDrop(!drop); })}>lose 30% of messages</Btn>
        <Btn ghost onClick={() => live.act((x) => { x.heal(); for (let i = 0; i < 3; i++) { x.recover(i); x.resume(i); } x.setDropRate(0); setDrop(false); })}>heal everything</Btn>
      </ButtonRow>
      <div style={{ fontSize: 12, marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
        {down.map((i) => <Chip key={`d${i}`} color="var(--c4)">{sname(i)} down</Chip>)}
        {cuts.map((c, i) => <Chip key={`c${i}`} color="var(--c2)">{c.map(sname).join(",")} cut off</Chip>)}
        {pausedNow.map((i) => <Chip key={`p${i}`} color="var(--c5)">{sname(i)} paused</Chip>)}
        {drop && <Chip color="var(--c2)">30% loss</Chip>}
      </div>
      <SpaceTime nodes={storeRows(s)} tStart={t0} tEnd={Math.max(t0 + WINDOW, t1)} messages={st.messages} marks={st.marks} rowHeight={34} />
      <Stats items={[
        { label: "operations", value: s.ops.length },
        { label: "answered", value: done },
        { label: "retries", value: s.ops.reduce((a, o) => a + Math.max(0, o.tries - 1), 0) },
        { label: "duplicates the sessions stopped", value: s.counters.dupSuppressed },
      ]} />
      {verdict && (
        <Banner ok={verdict.r.ok}>
          <Verdict ok={verdict.r.ok}>{verdict.r.ok ? "linearizable" : verdict.r.ok === null ? "unknown" : "not linearizable"}</Verdict>{" "}
          {verdict.ops} operations up to {Math.round(verdict.at)} ms, {verdict.r.explored.toLocaleString("en-US")} search states.
          {verdict.r.ok === false && ` No valid order for the red operation${verdict.r.blocked.length > 1 ? "s" : ""} after ${verdict.r.best.length} placed ones.`}
        </Banner>
      )}
      <SectionLabel>History (newest last)</SectionLabel>
      <OpList ops={s.ops.slice(-40)} bad={bad} max={170} />
      <Note>Three clients loop get, put, cas and del on x and y. Each write value is unique. The check runs the exact checker from the consistency module on the whole history; operations with no answer yet count as pending. Time runs at {fixed(160 / 1000, 2)}× real time.</Note>
    </Demo>
  );
}
