/** Demos for "the consensus problem": two quorums that must meet, and a naive leader protocol to break. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, MiniTable, Param, SmallLabel, Stats, BAD, GOOD, MONO, range, seg, toggle, useParams } from "../../kit";
import { disjointPairs, majority, minOverlap } from "../../sims/dist/consensus/paxos/quorum";
import { NAIVE_DEFAULTS, runNaive, type NaiveFault } from "../../sims/dist/consensus/paxos/naive";
import { SpaceTime, fromTrace } from "./SpaceTime";

// ============================================================================ 1. Two quorums

const Q_SCHEMA = { n: range({ label: "Nodes", min: 3, max: 9, step: 1, default: 5 }) };

const first = (n: number, k: number) => Array.from({ length: n }, (_, i) => i < k);
const last = (n: number, k: number) => Array.from({ length: n }, (_, i) => i >= n - k);

function Ring({ n, a, b }: { n: number; a: boolean[]; b: boolean[] }) {
  const W = 220, R = 78, c = W / 2;
  return (
    <svg viewBox={`0 0 ${W} ${W}`} style={{ width: "100%", maxWidth: 220, display: "block", margin: "0 auto" }} role="img" aria-label="nodes in quorums A and B">
      {Array.from({ length: n }, (_, i) => {
        const ang = (2 * Math.PI * i) / n - Math.PI / 2;
        const x = c + R * Math.cos(ang), y = c + R * Math.sin(ang);
        const both = a[i] && b[i];
        const fill = both ? "var(--c3)" : a[i] ? "var(--c1)" : b[i] ? "var(--c5)" : "var(--bg)";
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={both ? 19 : 16} fill={fill} stroke={both ? "var(--fg)" : "var(--border)"} strokeWidth={both ? 2 : 1.5} />
            <text x={x} y={y + 4} textAnchor="middle" fontSize="12" fontFamily={MONO} fill={a[i] || b[i] ? "var(--bg)" : "var(--muted)"}>N{i + 1}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Picker({ name, color, set, onToggle }: { name: string; color: string; set: boolean[]; onToggle: (i: number) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", marginBottom: 6 }}>
      <span style={{ width: 64, fontSize: 12.5, color, fontWeight: 600 }}>{name}</span>
      {set.map((on, i) => (
        <button key={i} className="btn" onClick={() => onToggle(i)} style={{ minWidth: 34, padding: "2px 6px", fontFamily: MONO, fontSize: 12, background: on ? color : undefined, color: on ? "var(--bg)" : undefined, borderColor: on ? color : undefined }}>
          N{i + 1}
        </button>
      ))}
    </div>
  );
}

export function ConsensusPaxosQuorumDemo() {
  const P = useParams("cp-quorum", Q_SCHEMA);
  const n = P.values.n;
  const maj = majority(n);
  const [sets, setSets] = useState<{ n: number; a: boolean[]; b: boolean[] }>({ n, a: first(n, maj), b: last(n, maj) });
  const cur = sets.n === n ? sets : { n, a: first(n, maj), b: last(n, maj) };
  const { a, b } = cur;
  const flip = (which: "a" | "b", i: number) => setSets({ ...cur, [which]: cur[which].map((v, k) => (k === i ? !v : v)) });
  const sa = a.filter(Boolean).length, sb = b.filter(Boolean).length;
  const shared = a.map((v, i) => (v && b[i] ? i : -1)).filter((i) => i >= 0);
  const table = useMemo(() => Array.from({ length: n }, (_, k) => ({ k: k + 1, ...disjointPairs(n, k + 1) })), [n]);
  const both = sa >= maj && sb >= maj;
  return (
    <Demo
      title="Do two quorums always meet?"
      actions={<ButtonRow><Btn onClick={() => setSets({ n, a: first(n, maj), b: last(n, maj) })}>Two majorities</Btn><Btn onClick={() => setSets({ n, a: first(n, Math.floor(n / 2)), b: last(n, Math.floor(n / 2)) })}>Two minorities</Btn></ButtonRow>}
      controls={<Param spec={Q_SCHEMA.n} value={n} onChange={(v) => P.set("n", v as number)} />}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12, alignItems: "center" }}>
        <div>
          <Picker name="Quorum A" color="var(--c1)" set={a} onToggle={(i) => flip("a", i)} />
          <Picker name="Quorum B" color="var(--c5)" set={b} onToggle={(i) => flip("b", i)} />
          <SmallLabel style={{ marginTop: 8 }}>Green nodes are in both quorums.</SmallLabel>
        </div>
        <Ring n={n} a={a} b={b} />
      </div>
      <Banner ok={shared.length > 0 ? true : both ? null : false}>
        {shared.length > 0
          ? `A and B share ${shared.map((i) => `N${i + 1}`).join(", ")}. A value that A accepted is visible to B through ${shared.length === 1 ? "that node" : "those nodes"}.`
          : `A and B share no node. A can decide one value and B another, and neither one can know.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "size of A", value: `${sa}${sa >= maj ? " (majority)" : ""}` },
          { label: "size of B", value: `${sb}${sb >= maj ? " (majority)" : ""}` },
          { label: "majority of n", value: maj },
          { label: "smallest possible overlap", value: minOverlap(sa, sb, n) },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 12 }}>Every pair of sets of size k, checked by brute force</SmallLabel>
      <MiniTable
        head={["k", "pairs", "pairs with no shared node"]}
        rows={table.map((r) => [r.k, r.pairs.toLocaleString("en-US"), <span key={r.k} style={{ color: r.disjoint === 0 ? GOOD : BAD }}>{r.disjoint.toLocaleString("en-US")}</span>])}
        highlight={(i) => i + 1 === maj}
      />
    </Demo>
  );
}

// ============================================================================ 2. The leader decides

const N_SCHEMA = {
  fault: seg<NaiveFault>("Adversary", [["none", "Nothing"], ["crash", "Leader crashes"], ["partition", "Cut off leader"], ["slow", "One slow message"]], "partition"),
  failover: toggle({ label: "Failover: a node that hears nothing takes over", default: true }),
  timeout: range({ label: "Takeover timeout step", min: 20, max: 100, step: 5, default: NAIVE_DEFAULTS.timeout, format: (v) => `${v} ms` }),
};

const vcol = (v: string) => (v === "A" ? "var(--c1)" : v === "B" ? "var(--c5)" : "var(--c2)");

export function ConsensusPaxosNaiveDemo() {
  const P = useParams("cp-naive", N_SCHEMA);
  const { fault, failover, timeout } = P.values;
  const r = useMemo(() => runNaive({ fault, failover, timeout }), [fault, failover, timeout]);
  const st = fromTrace(r.net);
  const marks = [
    ...st.marks,
    ...r.decided.flatMap((v, i) => (v !== null ? [{ node: i, t: r.at[i]!, label: `decide ${v}`, color: vcol(v) }] : [])),
    ...r.net.trace.flatMap((e) => (e.kind === "timer" && e.tag === "takeover" && r.at[e.node] === e.t ? [{ node: e.node, t: e.t, shape: "bar" as const, until: e.t + 2, color: "var(--c2)", label: "takes over" }] : [])),
    ...(fault === "partition" ? [{ node: 0, t: 0, until: NAIVE_DEFAULTS.horizon, shape: "bar" as const, color: "var(--c4)", label: "cut off" }] : []),
  ];
  return (
    <Demo
      title="The leader decides: break it"
      controls={<>
        <Param spec={N_SCHEMA.fault} value={fault} onChange={(v) => P.set("fault", v as NaiveFault)} />
        <Param spec={N_SCHEMA.failover} value={failover} onChange={(v) => P.set("failover", v as boolean)} />
        <Param spec={N_SCHEMA.timeout} value={timeout} onChange={(v) => P.set("timeout", v as number)} />
      </>}
    >
      <SmallLabel>Inputs: N1 has A, N2 has B, N3 has C. N1 is the leader. With failover, node i takes over at i × timeout. A message has the color of the value it carries.</SmallLabel>
      <SpaceTime nodes={["N1 lead", "N2", "N3"]} tEnd={NAIVE_DEFAULTS.horizon} messages={st.messages.map((m, i) => ({ ...m, label: undefined, color: vcol(r.net.messages[i]!.payload.v) }))} marks={marks} />
      <Stats items={[
        { label: "decisions", value: <span style={{ fontFamily: MONO }}>{r.decided.map((d) => d ?? "–").join(" ")}</span> },
        { label: "agreement", value: <span style={{ color: r.agreement ? GOOD : BAD }}>{r.agreement ? "holds" : "broken"}</span> },
        { label: "termination", value: <span style={{ color: r.termination ? GOOD : BAD }}>{r.termination ? "holds" : "broken"}</span> },
      ]} />
      <Banner ok={r.agreement && r.termination}>
        {r.agreement && r.termination
          ? "Every node decided the same value. This adversary was too weak."
          : !r.agreement
            ? `Two values were decided. ${fault === "slow" ? "No node failed: N3 only waited less than the slow message took." : fault === "crash" ? "N1 decided A before it crashed. If it told a client, that client saw A." : "Each side of the cut decided on its own."}`
            : "Agreement holds, but some live node waits forever. Without failover, one crash stops everything."}
      </Banner>
    </Demo>
  );
}
