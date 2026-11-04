/** Demos for "virtual machines and hypervisors": trap and emulate, the VM exit stepper, the workload model and the nested walk grid. */
import { useMemo, useState } from "react";
import { Demo, Line, Dots, Legend, Param, Plot, Stats, range, select, useParams, useWidth } from "../../kit";
import {
  DEFAULT_FEATURES, EMULATED_WRITES_PER_PACKET, GUEST_OPS, VM_COST, WORKLOADS, X86_CLASSIC, lostFraction, nativeReads, nestedWalkReads, opById, opCost, popekGoldbergViolators, realNestedWalk, virtualizable, vtxBehaviour, workloadOverhead,
  type DeviceModel, type Lane, type NestedPageSize, type VmFeatures,
} from "../../sims/os/isolation";
import { Badge, Card, Meter, Note, Scroll, Verdict, mono, seg, smallTable, td, th, twoCol } from "./IsolationUi";

// ---------------- trap and emulate ----------------

export function IsolationTrapDemo() {
  const P = useParams("iso-trap", {
    mode: seg<"classic" | "vtx">("Hardware", [["classic", "Classic x86: guest kernel in ring 3"], ["vtx", "VT-x: guest kernel in non-root ring 0"]], "classic"),
  });
  const [name, setName] = useState("popf");
  const ins = X86_CLASSIC.find((i) => i.name === name)!;
  const classic = P.values.mode === "classic";
  const violators = popekGoldbergViolators(X86_CLASSIC);
  const silent = classic && ins.sensitive && !ins.privileged;
  return (
    <Demo title="Trap and emulate: which instructions give the guest away?" controls={<Param spec={P.schema.mode} value={P.values.mode} onChange={(v) => P.set("mode", v as "classic" | "vtx")} />}>
      <Scroll>
        <table style={smallTable}>
          <thead><tr><th style={th}>instruction</th><th style={th}>sensitive</th><th style={th}>privileged</th><th style={th}>problem</th></tr></thead>
          <tbody>
            {X86_CLASSIC.map((i) => {
              const bad = i.sensitive && !i.privileged;
              return (
                <tr key={i.name} onClick={() => setName(i.name)} style={{ cursor: "pointer", background: i.name === name ? "var(--subtle)" : undefined }}>
                  <td style={{ ...td, ...mono }}>{i.name}</td>
                  <td style={td}>{i.sensitive ? "yes" : "no"}</td>
                  <td style={td}>{i.privileged ? "yes" : "no"}</td>
                  <td style={td}>{bad && classic ? <Badge tone="bad">no trap</Badge> : bad ? <Badge tone="good">fixed</Badge> : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Scroll>
      <div style={{ ...twoCol, marginTop: 8 }}>
        <Card title={<>What the guest wants from <span style={mono}>{ins.name}</span></>}><span style={{ fontSize: 13 }}>{ins.ring0}</span></Card>
        <Card title="What really happens"><span style={{ fontSize: 13 }}>{classic ? ins.ring3 : vtxBehaviour(ins)}</span></Card>
      </div>
      {classic
        ? <Verdict tone={silent ? "bad" : "none"}>{virtualizable(X86_CLASSIC) ? "" : `Sensitive is not a subset of privileged: ${violators.map((v) => v.name).join(", ")} run without a trap. So classic x86 fails the theorem.`}</Verdict>
        : <Verdict tone="good">Non-root mode gives the guest kernel a real ring 0. The sensitive state belongs to the guest, or the instruction causes a VM exit.</Verdict>}
    </Demo>
  );
}

// ---------------- VM exit stepper ----------------

const LANES: { id: Lane; label: string; color: string }[] = [
  { id: "qemu", label: "QEMU (root, ring 3)", color: "var(--c5)" },
  { id: "kvm", label: "KVM (root, ring 0)", color: "var(--c2)" },
  { id: "guest", label: "Guest (non-root)", color: "var(--c3)" },
];
const ns = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} µs` : `${v} ns`);

export function IsolationVmExitDemo() {
  const P = useParams("iso-vmexit", {
    op: select({ label: "Guest instruction", options: GUEST_OPS.map((o) => ({ value: o.id, label: `${o.label}: ${o.asm}` })), default: "cpuid" }),
  });
  const [f, setF] = useState<VmFeatures>(DEFAULT_FEATURES);
  const [at, setAt] = useState<number | null>(null);
  const op = opById(P.values.op);
  const cost = opCost(op, f);
  const stages = cost.stages;
  const shown = at ?? stages.length - 1;
  const [svgRef, measured] = useWidth<HTMLDivElement>();
  const W = Math.max(280, measured), H = 150, laneH = 38, left = 6;
  const widths = stages.map((s) => Math.max(0.5, Math.log10(1 + s.ns)));
  const totalW = widths.reduce((a, b) => a + b, 0);
  const xs: number[] = [];
  widths.reduce((acc, w, i) => { xs[i] = acc; return acc + w; }, 0);
  const sx = (v: number) => left + (v / totalW) * (W - 2 * left);
  const y = (l: Lane) => 8 + LANES.findIndex((x) => x.id === l) * (laneH + 8);
  const cur = stages[shown];
  const FEATS: { k: keyof VmFeatures; label: string }[] = [{ k: "ept", label: "EPT" }, { k: "tscOffset", label: "TSC offset" }, { k: "apicv", label: "APICv" }, { k: "ioeventfd", label: "ioeventfd" }];
  return (
    <Demo title="What one guest instruction costs" controls={<>
      <Param spec={P.schema.op} value={P.values.op} onChange={(v) => { P.set("op", v as string); setAt(null); }} />
      {FEATS.map((x) => <label key={x.k} className="param" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><input type="checkbox" checked={f[x.k]} onChange={() => { setF({ ...f, [x.k]: !f[x.k] }); setAt(null); }} /><span>{x.label}</span></label>)}
    </>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn" onClick={() => setAt(0)}>Start</button>
        <button className="btn primary" disabled={shown >= stages.length - 1} onClick={() => setAt(shown + 1)}>Step</button>
        <span className="muted" style={{ fontSize: 12 }}>stage {shown + 1} of {stages.length}</span>
      </div>
      <div ref={svgRef}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: "block", maxWidth: "100%" }} role="img" aria-label="Time spent in guest, KVM and QEMU">
        {LANES.map((l) => (
          <g key={l.id}>
            <rect x={0} y={y(l.id)} width={W} height={laneH} fill="var(--subtle)" />
            <text x={6} y={y(l.id) + 12} style={{ fontSize: 11, fill: "var(--muted)" }}>{l.label}</text>
          </g>
        ))}
        {stages.map((s, i) => {
          const lane = LANES.find((l) => l.id === s.lane)!;
          const x0 = sx(xs[i]!), w = sx(xs[i]! + widths[i]!) - x0;
          const visible = i <= shown;
          return <rect key={i} x={x0} y={y(s.lane) + 16} width={Math.max(2, w - 1)} height={laneH - 18} fill={lane.color} opacity={visible ? (i === shown ? 1 : 0.55) : 0.1} />;
        })}
      </svg>
      </div>
      <Note>Widths use a log scale of each stage's time, so that short stages stay visible.</Note>
      <Verdict tone={cost.exits ? (cost.toUserspace ? "bad" : "warn") : "good"}>
        <b>{cost.exits ? (cost.toUserspace ? "VM exit, all the way to user space" : "VM exit, handled in the kernel") : "No VM exit"}</b>. {op.why(f)}
        {cur && <div style={{ ...mono, fontSize: 12, marginTop: 4 }}>{cur.label}: {ns(cur.ns)}</div>}
      </Verdict>
      <div style={{ marginTop: 8 }}>
        <Stats items={[{ label: "total (model)", value: ns(cost.totalNs) }, { label: "same work with no VM (model)", value: ns(cost.nativeNs) }, { label: "ratio", value: cost.nativeNs > 0 ? `${cost.ratio < 10 ? cost.ratio.toFixed(1) : Math.round(cost.ratio)}×` : "–" }]} />
      </div>
      <Scroll style={{ marginTop: 10 }}>
        <table style={smallTable}>
          <thead><tr><th style={th}>instruction</th><th style={th}>exits?</th><th style={{ ...th, textAlign: "right" }}>cost</th></tr></thead>
          <tbody>{GUEST_OPS.map((o) => { const c = opCost(o, f); return (
            <tr key={o.id} onClick={() => { P.set("op", o.id); setAt(null); }} style={{ cursor: "pointer", background: o.id === op.id ? "var(--subtle)" : undefined }}>
              <td style={td}>{o.label}</td>
              <td style={td}>{c.exits ? <Badge tone={c.toUserspace ? "bad" : "warn"}>{c.toUserspace ? "to QEMU" : "to KVM"}</Badge> : <Badge tone="good">no</Badge>}</td>
              <td style={{ ...td, ...mono, textAlign: "right", whiteSpace: "nowrap" }}>{ns(c.totalNs)}</td>
            </tr>
          ); })}</tbody>
        </table>
      </Scroll>
      <Note>All times are model inputs: {VM_COST.exitEntryNs} ns for the hardware exit and entry, {VM_COST.kernelNs} ns for a small KVM handler, {ns(VM_COST.userspaceNs)} for a trip to QEMU, {VM_COST.indirectNs} ns of lost cache and TLB state.</Note>
    </Demo>
  );
}

// ---------------- workload ----------------

export function IsolationWorkloadDemo() {
  const P = useParams("iso-vmwork", {
    work: select({ label: "Workload", options: WORKLOADS.map((w) => ({ value: w.id, label: w.label })), default: "web" }),
    batch: range({ label: "Packets or I/Os per virtio kick", min: 1, max: 64, step: 1, default: 16 }),
    device: seg<DeviceModel>("Device", [["virtio", "virtio"], ["emulated", "Emulated"]], "virtio"),
  });
  const w = WORKLOADS.find((x) => x.id === P.values.work)!;
  const r = workloadOverhead(w, P.values.device, P.values.batch);
  const kernelCost = opCost(opById("kick")).totalNs;
  const userCost = opCost(opById("mmio")).totalNs;
  const rates = useMemo(() => Array.from({ length: 41 }, (_, i) => 100 * 10 ** (i / 10)), []);
  const lineK = rates.map((x) => [x, lostFraction(x, kernelCost) * 100] as [number, number]);
  const lineU = rates.map((x) => [x, lostFraction(x, userCost) * 100] as [number, number]);
  const maxLost = Math.max(...r.parts.map((p) => p.lostNs), 1);
  return (
    <Demo title="How much time do VM exits take from a workload?" controls={<>
      <Param spec={P.schema.batch} value={P.values.batch} onChange={(v) => P.set("batch", v as number)} />
      <Param spec={P.schema.work} value={P.values.work} onChange={(v) => P.set("work", v as string)} />
      <Param spec={P.schema.device} value={P.values.device} onChange={(v) => P.set("device", v as DeviceModel)} />
    </>}>
      <Stats items={[
        { label: "exits per second", value: Math.round(r.exits).toLocaleString("en-US") },
        { label: "CPU time lost", value: r.lost >= 1 ? "100%: it cannot keep up" : `${(r.lost * 100).toFixed(1)}%` },
        { label: "slowdown", value: r.lost >= 1 ? "–" : `${r.slowdown.toFixed(3)}×` },
      ]} />
      <div style={{ marginTop: 8 }}>
        {r.parts.filter((p) => p.exits > 0).map((p) => <Meter key={p.label} label={`${p.label}: ${Math.round(p.exits).toLocaleString("en-US")} per second`} value={p.lostNs} max={maxLost} color="var(--c2)" text={`${(p.lostNs / 1e7).toFixed(2)}%`} />)}
      </div>
      <Plot x={[100, 1e6]} y={[0, 100]} logX height={220} xLabel="exits per second" yLabel="CPU time lost (%)" xTicks={[100, 1000, 10000, 100000, 1000000]} xFormat={(v) => (v >= 1e6 ? "1M" : v >= 1000 ? `${v / 1000}k` : String(v))}>
        <Line points={lineU} color="var(--c4)" />
        <Line points={lineK} color="var(--c2)" />
        <Dots points={[[Math.max(100, Math.min(1e6, r.exits)), Math.min(100, r.lost * 100)]]} color="var(--fg)" r={5} />
      </Plot>
      <Legend items={[{ label: `exit to QEMU: ${(userCost / 1000).toFixed(1)} µs`, color: "var(--c4)" }, { label: `exit to KVM: ${(kernelCost / 1000).toFixed(1)} µs`, color: "var(--c2)" }, { label: "this workload", color: "var(--fg)" }]} />
      <Note>Model inputs: the workload rates, and {EMULATED_WRITES_PER_PACKET} register writes per packet on an emulated device.</Note>
    </Demo>
  );
}

// ---------------- nested walk ----------------

export function IsolationNestedWalkDemo() {
  const P = useParams("iso-nested", {
    guestLevels: seg<string>("Guest levels", [["4", "4"], ["5", "5"]], "4"),
    hostLevels: seg<string>("EPT levels", [["4", "4"], ["5", "5"]], "4"),
    guestPage: seg<NestedPageSize>("Guest page", [["4k", "4 KiB"], ["2m", "2 MiB"], ["1g", "1 GiB"]], "4k"),
    hostPage: seg<NestedPageSize>("Host page", [["4k", "4 KiB"], ["2m", "2 MiB"], ["1g", "1 GiB"]], "4k"),
  });
  const v = P.values;
  const gl = Number(v.guestLevels) as 4 | 5, hl = Number(v.hostLevels) as 4 | 5;
  const walk = useMemo(() => realNestedWalk({ guestLevels: gl, hostLevels: hl, guestPage: v.guestPage, hostPage: v.hostPage }), [gl, hl, v.guestPage, v.hostPage]);
  const [hover, setHover] = useState<number | null>(null);
  const cols = walk.guestDepth + 1, rows = walk.hostDepth + 1;
  const at = (r: number, c: number) => walk.reads.find((x) => x.row === r && x.col === c);
  const focus = hover === null ? null : walk.reads[hover - 1];
  const onPath = (n: number) => hover !== null && n <= hover;
  return (
    <Demo title="The 2D walk: every read for one TLB miss" controls={<>
      <Param spec={P.schema.guestLevels} value={v.guestLevels} onChange={(x) => { P.set("guestLevels", x as string); setHover(null); }} />
      <Param spec={P.schema.hostLevels} value={v.hostLevels} onChange={(x) => { P.set("hostLevels", x as string); setHover(null); }} />
      <Param spec={P.schema.guestPage} value={v.guestPage} onChange={(x) => { P.set("guestPage", x as NestedPageSize); setHover(null); }} />
      <Param spec={P.schema.hostPage} value={v.hostPage} onChange={(x) => { P.set("hostPage", x as NestedPageSize); setHover(null); }} />
    </>}>
      <Stats items={[
        { label: "memory reads, by the real walkers", value: walk.reads.length },
        { label: `(${walk.guestDepth} + 1)(${walk.hostDepth} + 1) - 1`, value: nestedWalkReads(walk.guestDepth, walk.hostDepth) },
        { label: "reads with no VM", value: nativeReads(walk.guestDepth) },
        { label: "ratio", value: `${(walk.reads.length / nativeReads(walk.guestDepth)).toFixed(1)}×` },
      ]} />
      <div style={{ marginTop: 10 }} onMouseLeave={() => setHover(null)}>
        <div style={{ display: "grid", gridTemplateColumns: `minmax(62px, auto) repeat(${cols}, minmax(0, 1fr))`, gap: 3, fontSize: 11 }}>
          <div />
          {walk.colNames.map((c, i) => <div key={i} className="muted" style={{ textAlign: "center", overflow: "hidden" }}>{i === cols - 1 ? "data" : `g ${c}`}</div>)}
          {walk.rowNames.map((rn, r) => (
            <div key={r} style={{ display: "contents" }}>
              <div className="muted" style={{ alignSelf: "center" }}>{r === rows - 1 ? "guest entry" : `EPT ${rn}`}</div>
              {Array.from({ length: cols }, (_, c) => {
                const read = at(r, c);
                if (!read) return <div key={c} style={{ height: 34, borderRadius: 3, border: "1px dashed var(--border)", display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 10 }}>{r === rows - 1 && c === cols - 1 ? "the data" : ""}</div>;
                const isHost = read.kind === "host";
                const active = hover === read.n;
                const done = onPath(read.n);
                return (
                  <button key={c} onMouseEnter={() => setHover(read.n)} onFocus={() => setHover(read.n)} onClick={() => setHover(read.n)} aria-label={`read ${read.n}: ${read.label}`}
                    style={{ ...mono, height: 34, padding: 0, borderRadius: 3, cursor: "pointer", fontSize: 12.5, fontWeight: active ? 700 : 500,
                      border: `1.5px solid ${active ? "var(--fg)" : isHost ? "var(--c2)" : "var(--c1)"}`,
                      background: active ? "var(--fg)" : done ? (isHost ? "var(--c2)" : "var(--c1)") : "var(--bg)",
                      color: active ? "var(--bg)" : done ? "var(--bg)" : "var(--fg)" }}>
                    {read.n}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <Legend items={[{ label: "host table read (EPT)", color: "var(--c2)" }, { label: "guest table read", color: "var(--c1)" }]} />
      <Verdict tone={focus ? "info" : "none"}>
        {focus ? <><b>Read {focus.n}.</b> {focus.label}. <span style={mono}>hpa 0x{focus.hpa.toString(16)}</span></> : "Hover or tap a cell. The numbers give the order, and all earlier reads light up."}
      </Verdict>
    </Demo>
  );
}
