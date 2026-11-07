/** Demos for "BGP": the decision process at one router, and policy, hijacks, leaks and RPKI across an AS graph. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Legend, MiniTable, Note, Param, SectionLabel, Stats, range, seg, toggle, useParams } from "../../kit";
import { formatIpv4 } from "../../sims/net";
import {
  ATTACKER, LEAKER, LESSON_GRAPH, SUB_PREFIX, VICTIM, VICTIM_PREFIX, bgpDecision, formatCidr, relOf, rov, runScenario, valleyFree, type Candidate, type Scenario,
} from "../../sims/net/ip";
import { TopoView, type TopoLink, type TopoNode } from "./NetIpUi";

// ============================================================================ 1. The decision process

const DEC = {
  prepend: range({ label: "AS 65010 prepends itself on the route via AS 65001", min: 0, max: 4, step: 1, default: 0, format: (v) => `${v} extra` }),
  lp: range({ label: "LOCAL_PREF for routes from transit AS 65002", min: 50, max: 300, step: 10, default: 100 }),
  med: range({ label: "MED on the eBGP route from AS 65001", min: 0, max: 50, step: 5, default: 0 }),
  origin: toggle({ label: "Route 2 has ORIGIN INCOMPLETE (redistributed)", default: false }),
};

export function NetIpBgpDecisionDemo() {
  const P = useParams("net-ip-bgpdec", DEC);
  const { prepend, lp, med, origin } = P.values;
  const pre = Array.from({ length: prepend }, () => 65010);
  const cands: Candidate[] = [
    { name: "1 eBGP", localPref: 100, asPath: [65001, ...pre, 65010], origin: "IGP", med, ebgp: true, igpCost: 10, routerId: 0xc0000201 },
    { name: "2 eBGP", localPref: lp, asPath: [65002, 65020, 65010], origin: origin ? "INCOMPLETE" : "IGP", med: 0, ebgp: true, igpCost: 10, routerId: 0xc0000202 },
    { name: "3 iBGP", localPref: 100, asPath: [65001, ...pre, 65010], origin: "IGP", med: 20, ebgp: false, igpCost: 5, routerId: 0xc0000203 },
  ];
  const { steps, winner } = bgpDecision(cands);
  const decided = steps.findIndex((s) => s.left.length === 1);
  return (
    <Demo title="Three routes to 203.0.113.0/24: which one wins?"
      controls={<>
        <Param spec={DEC.prepend} value={prepend} onChange={(v) => P.set("prepend", v as number)} />
        <Param spec={DEC.lp} value={lp} onChange={(v) => P.set("lp", v as number)} />
        <Param spec={DEC.med} value={med} onChange={(v) => P.set("med", v as number)} />
        <Param spec={DEC.origin} value={origin} onChange={(v) => P.set("origin", v as boolean)} />
      </>}
    >
      <MiniTable
        head={["route", "LOCAL_PREF", "AS_PATH", "ORIGIN", "MED", "IGP cost", "peer ID"]}
        rows={cands.map((c) => [c.name, c.localPref, c.asPath.join(" "), c.origin, c.med, c.igpCost, formatIpv4(c.routerId)])}
        highlight={winner}
      />
      <Note>Routes 1 and 2 come from eBGP neighbours of this router. Route 3 comes over iBGP from our other border router, which heard it from AS 65001.</Note>
      <SectionLabel>The decision, rule by rule</SectionLabel>
      <div style={{ display: "grid", gap: 4 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, opacity: decided >= 0 && i > decided ? 0.4 : 1, flexWrap: "wrap" }}>
            <span style={{ width: 18, textAlign: "right" }} className="muted">{i + 1}.</span>
            <span style={{ minWidth: 0, flex: "1 1 200px" }}>{s.rule}</span>
            <span style={{ display: "flex", gap: 4 }}>
              {cands.map((_, j) => {
                const out = s.removed.includes(j), alive = s.left.includes(j);
                return <Chip key={j} color={out ? "var(--c4)" : alive ? (i === decided ? "var(--c3)" : "var(--fg)") : "var(--faint)"} strike={out} faint={!out && !alive} filled={i === decided && alive}>{j + 1}</Chip>;
              })}
            </span>
          </div>
        ))}
      </div>
      <Banner tone="good">Route {winner + 1} wins at rule {decided + 1}: {steps[decided]!.rule}.</Banner>
      <Note>Rules after the deciding one do not matter. A router compares MED only between routes from the same neighbour AS, so route 2 never loses on MED.</Note>
    </Demo>
  );
}

// ============================================================================ 2. Policy, hijacks, leaks, RPKI

const POL = {
  scenario: seg("Scenario", [["normal", "normal"], ["hijack", "same-prefix hijack"], ["subprefix", "sub-prefix hijack"], ["forged", "forged origin"], ["leak", "route leak"]], "subprefix"),
  maxLength: range({ label: "maxLength in AS6's ROA", min: 22, max: 24, step: 1, default: 22, format: (v) => `/${v}` }),
};

const ROV_PRESETS: [string, number[]][] = [["no ROV", []], ["tier-1s", [1, 2]], ["all transit", [1, 2, 3, 4, 5]], ["only AS5", [5]]];

export function NetIpBgpPolicyDemo() {
  const P = useParams("net-ip-bgppol", POL);
  const { scenario, maxLength } = P.values;
  const [rovSet, setRov] = useState<number[]>([]);
  const [sel, setSel] = useState(9);
  const res = useMemo(() => runScenario(scenario as Scenario, new Set(rovSet), maxLength), [scenario, rovSet, maxLength]);
  const g = LESSON_GRAPH;
  const w = res.walks.get(sel)!;
  const onPath = new Set(w.path.slice(0, -1).map((a, i) => `${a}-${w.path[i + 1]}`));
  const nodes: TopoNode[] = g.nodes.map((n) => {
    const wk = res.walks.get(n.asn)!;
    const fill = wk.end === VICTIM ? "var(--c3)" : wk.end === ATTACKER ? "var(--c4)" : undefined;
    const role = n.asn === VICTIM ? "victim" : n.asn === ATTACKER && scenario !== "normal" && scenario !== "leak" ? "attacker" : n.asn === LEAKER && scenario === "leak" ? "leaker" : rovSet.includes(n.asn) ? "ROV" : undefined;
    return { id: n.asn, label: n.name, x: n.x, y: n.y, fill, color: n.asn === sel ? "var(--fg)" : rovSet.includes(n.asn) ? "var(--c1)" : "var(--muted)", bold: n.asn === sel || rovSet.includes(n.asn), sub: role, square: n.tier === 3 };
  });
  const links: TopoLink[] = g.links.map((l) => {
    const hot = onPath.has(`${l.a}-${l.b}`) || onPath.has(`${l.b}-${l.a}`);
    return { a: l.a, b: l.b, dashed: l.kind === "p2p", color: hot ? "var(--c2)" : undefined, width: hot ? 3 : 1.3 };
  });
  const routes = [...res.state.best.get(sel)!.values()];
  const anyAttack = scenario === "hijack" || scenario === "subprefix" || scenario === "forged";
  const roas = [{ prefix: VICTIM_PREFIX, maxLength, asn: VICTIM }];
  const summary = scenario === "leak"
    ? `${res.viaLeaker} networks now send AS6's traffic through AS12, a small customer network. The route stays valid in RPKI, so ROV does not help.`
    : anyAttack ? `${res.captured} of 9 other networks send traffic for ${formatIpv4(0xc633640a)} to the attacker.` : "Every network reaches AS6.";
  return (
    <Demo title="Policy, hijacks and leaks across twelve networks"
      controls={<>
        <Param spec={POL.scenario} value={scenario} onChange={(v) => P.set("scenario", v as "normal")} />
        <Param spec={POL.maxLength} value={maxLength} onChange={(v) => P.set("maxLength", v as number)} />
      </>}
    >
      <TopoView nodes={nodes} links={links} height={250} r={16} onNode={setSel} />
      <Legend items={[{ label: "traffic reaches AS6", color: "var(--c3)" }, { label: "traffic reaches the attacker", color: "var(--c4)" }, { label: "path from the selected AS", color: "var(--c2)" }]} />
      <Note>Solid links: customer below, provider above. Dashed: peers. Click an AS to see its routes.</Note>
      <ButtonRow style={{ marginTop: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Who drops RPKI-invalid routes:</span>
        {ROV_PRESETS.map(([name, s]) => <Btn key={name} ghost={rovSet.join() !== s.join()} onClick={() => setRov(s)}>{name}</Btn>)}
      </ButtonRow>
      <SectionLabel>{`AS${sel}: best routes, and where its packets for ${formatIpv4(0xc633640a)} go`}</SectionLabel>
      <MiniTable head={["prefix", "AS_PATH", "learned from", "RPKI"]}
        rows={routes.map((r) => [formatCidr(r.prefix), r.path.length ? r.path.join(" ") : "(own)", r.from === null ? "itself" : `${relOf(g, sel, r.from)} AS${r.from}`, rov(roas, r.prefix, r.path.length ? r.path[r.path.length - 1]! : sel)])} />
      <div style={{ fontSize: 13, marginTop: 6 }}>
        Packets: {w.path.map((a) => `AS${a}`).join(" → ")} {w.fate === "arrived" ? (w.end === ATTACKER && sel !== ATTACKER ? "(the attacker)" : "") : `(${w.fate})`}
        {w.path.length > 2 && !valleyFree(g, w.path) ? " · not valley-free" : ""}
      </div>
      <Banner tone={res.captured || res.viaLeaker ? "bad" : "good"}>{summary}</Banner>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "networks captured", value: res.captured },
          { label: "through the leaker", value: res.viaLeaker },
          { label: "rounds to converge", value: res.state.rounds },
          { label: "best-route changes (UPDATEs)", value: res.state.changes },
        ]} />
      </div>
      <Note>AS6 announces {formatCidr(VICTIM_PREFIX)}; the sub-prefix attacks announce {formatCidr(SUB_PREFIX)}. These prefixes and AS numbers are made up for the model.</Note>
    </Demo>
  );
}
