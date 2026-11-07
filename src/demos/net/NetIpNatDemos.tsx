/** Demos for "NAT": a translation table you drive with packets, and UDP hole punching between two NATs. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, MONO, MiniTable, Note, Param, SectionLabel, Stats, range, seg, toggle, useParams, GOOD, BAD } from "../../kit";
import { formatIpv4 } from "../../sims/net";
import { SpaceTime, type StMark } from "../dist/SpaceTime";
import { fromPackets } from "./PacketViews";
import { IP, NatWorld, classicName, ep, holePunch, type FilteringBehavior, type MappingBehavior, type Seg } from "../../sims/net/ip";

// ============================================================================ 1. The translation table

const NT = {
  timeout: range({ label: "Idle timeout of a mapping", min: 30, max: 600, step: 30, default: 120, format: (v) => `${v} s` }),
  mapping: seg("Mapping", [["eim", "endpoint-independent"], ["adm", "address-dependent"], ["apdm", "address and port"]], "eim"),
  filtering: seg("Filtering", [["eif", "endpoint-independent"], ["adf", "address-dependent"], ["apdf", "address and port"]], "apdf"),
  hairpin: toggle({ label: "Hairpinning supported", default: true }),
};

const PUB = 0xcb00710a; // 203.0.113.10
const H1 = 0xc0a8010a, H2 = 0xc0a8010b; // 192.168.1.10, .11
const X = 0xc6336407, Y = 0xc0000209; // 198.51.100.7, 192.0.2.9

type ActionId = "h1x" | "h2x" | "h1y" | "xreply" | "yprobe" | "xother" | "hairpin" | "wait";
const ACTIONS: { id: ActionId; label: string }[] = [
  { id: "h1x", label: "H1 → X:443" },
  { id: "h2x", label: "H2 → X:443" },
  { id: "h1y", label: "H1 → Y:3478" },
  { id: "xreply", label: "X replies to H1" },
  { id: "xother", label: "X:8080 → H1's port" },
  { id: "yprobe", label: "Y → H1's port" },
  { id: "hairpin", label: "H2 → H1 via 203.0.113.10" },
  { id: "wait", label: "Wait 3 minutes" },
];

interface Step {
  id: ActionId;
  t: number;
  before?: Seg;
  after?: Seg;
  result: { text: string; ok: boolean }[];
}

function replay(actions: ActionId[], cfg: { mapping: MappingBehavior; filtering: FilteringBehavior; hairpin: boolean; timeoutMs: number }) {
  const w = new NatWorld({
    nats: [{ name: "NAT", publicIp: PUB, cfg: { ...cfg, preservePort: true }, hosts: [{ name: "H1", ip: H1 }, { name: "H2", ip: H2 }] }],
    servers: [{ name: "X", ip: X }, { name: "Y", ip: Y }],
  });
  const nat = w.nat("NAT");
  const NATN = w.node.get("NAT")!;
  const steps: Step[] = [];
  w.onApp = (node, seg) => {
    const who = w.net.names[node]!;
    const cur = steps[steps.length - 1];
    if (cur) {
      cur.after = seg;
      cur.result.push({ text: `${who} received ${ep({ ip: seg.sip, port: seg.sport })} → ${ep({ ip: seg.dip, port: seg.dport })}`, ok: true });
    }
  };
  let lastH1Port: number | undefined;
  const h1Port = (remote: number) => {
    const now = (nat.entries.find((e) => e.inside.ip === H1 && e.remote.ip === remote) ?? nat.entries.find((e) => e.inside.ip === H1))?.ext;
    if (now !== undefined) lastH1Port = now;
    return lastH1Port;
  };
  let t = 0;
  for (const id of actions) {
    if (id === "wait") {
      t += 180_000;
      w.net.at(t, () => {
        nat.expire(w.net.now);
        steps.push({ id, t: w.net.now, result: [{ text: `Three minutes later: ${nat.entries.length} mapping${nat.entries.length === 1 ? "" : "s"} left.`, ok: true }] });
      });
      continue;
    }
    t += 50;
    w.net.at(t, () => {
      const step: Step = { id, t: w.net.now, result: [] };
      steps.push(step);
      const logStart = w.log.length;
      let seg: Seg | undefined, from = "";
      const xPort = h1Port(X);
      if (id === "h1x") { from = "H1"; seg = { sip: H1, sport: 5000, dip: X, dport: 443, kind: "data" }; }
      if (id === "h2x") { from = "H2"; seg = { sip: H2, sport: 5000, dip: X, dport: 443, kind: "data" }; }
      if (id === "h1y") { from = "H1"; seg = { sip: H1, sport: 5000, dip: Y, dport: 3478, kind: "data" }; }
      if (id === "xreply" || id === "xother" || id === "yprobe") {
        if (xPort === undefined) { step.result.push({ text: "H1 has no mapping yet: send from H1 first.", ok: false }); return; }
        from = id === "yprobe" ? "Y" : "X";
        seg = { sip: id === "yprobe" ? Y : X, sport: id === "xreply" ? 443 : id === "xother" ? 8080 : 3478, dip: PUB, dport: xPort, kind: "data" };
      }
      if (id === "hairpin") {
        if (xPort === undefined) { step.result.push({ text: "H1 has no mapping yet: send from H1 first.", ok: false }); return; }
        from = "H2"; seg = { sip: H2, sport: 7000, dip: PUB, dport: xPort, kind: "data" };
      }
      step.before = seg;
      w.send(from, seg!);
      w.net.at(w.net.now + 40, () => {
        for (const l of w.log.slice(logStart)) if (l.node === NATN) step.result.unshift({ text: `NAT: ${l.text}`, ok: l.tone !== "drop" });
      });
    });
  }
  w.net.runAll(100_000);
  return { steps, nat, now: w.net.now };
}

export function NetIpNatTableDemo() {
  const P = useParams("net-ip-nat", NT);
  const { timeout, mapping, filtering, hairpin } = P.values;
  const [actions, setActions] = useState<ActionId[]>(["h1x", "h2x", "xreply"]);
  const r = useMemo(() => replay(actions, { mapping: mapping as MappingBehavior, filtering: filtering as FilteringBehavior, hairpin, timeoutMs: timeout * 1000 }), [actions, mapping, filtering, hairpin, timeout]);
  const last = r.steps[r.steps.length - 1];
  const field = (s: Seg | undefined, k: "src" | "dst") => (s ? (k === "src" ? ep({ ip: s.sip, port: s.sport }) : ep({ ip: s.dip, port: s.dport })) : "–");
  const changed = (k: "src" | "dst") => last?.before && last.after && field(last.before, k) !== field(last.after, k);
  const ok = last ? last.result.every((x) => x.ok) && !!last.after : true;
  return (
    <Demo title="A NAT's translation table"
      actions={<Btn ghost onClick={() => setActions(["h1x", "h2x", "xreply"])}>Reset</Btn>}
      controls={<>
        <Param spec={NT.timeout} value={timeout} onChange={(v) => P.set("timeout", v as number)} />
        <Param spec={NT.mapping} value={mapping} onChange={(v) => P.set("mapping", v as "eim")} />
        <Param spec={NT.filtering} value={filtering} onChange={(v) => P.set("filtering", v as "eif")} />
        <Param spec={NT.hairpin} value={hairpin} onChange={(v) => P.set("hairpin", v as boolean)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Inside: H1 192.168.1.10 and H2 192.168.1.11. The NAT's public address: 203.0.113.10. Outside: X 198.51.100.7 and Y 192.0.2.9.</div>
      <ButtonRow>
        {ACTIONS.map((a) => <Btn key={a.id} onClick={() => setActions([...actions, a.id])}>{a.label}</Btn>)}
      </ButtonRow>
      {last && last.id !== "wait" && (
        <>
          <SectionLabel>The last packet, before and after the NAT</SectionLabel>
          <MiniTable head={["", "source", "destination"]} rows={[
            ["sent", field(last.before, "src"), field(last.before, "dst")],
            ["delivered", last.after ? <span style={{ color: changed("src") ? "var(--c2)" : undefined }}>{field(last.after, "src")}</span> : "–", last.after ? <span style={{ color: changed("dst") ? "var(--c2)" : undefined }}>{field(last.after, "dst")}</span> : "–"],
          ]} />
        </>
      )}
      {last && <Banner tone={ok ? "good" : "bad"}>{last.result.map((x) => x.text).join(". ")}.</Banner>}
      <SectionLabel>Translation table at the end</SectionLabel>
      {r.nat.entries.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>empty</div> : (
        <MiniTable head={["inside", "external", "made for", "lets in", "expires in"]}
          rows={r.nat.entries.map((e) => [
            <span style={{ fontFamily: MONO }}>{ep(e.inside)}</span>,
            <span style={{ fontFamily: MONO }}>{ep({ ip: PUB, port: e.ext })}</span>,
            mapping === "eim" ? "any remote" : mapping === "adm" ? formatIpv4(e.remote.ip) : ep(e.remote),
            filtering === "eif" ? "anyone" : [...e.permits].filter((p) => (filtering === "adf" ? !p.includes(":") : p.includes(":"))).join(", "),
            `${Math.max(0, Math.round((e.lastUsed + timeout * 1000 - r.now) / 1000))} s`,
          ])} />
      )}
      <Note>History: {r.steps.map((s) => ACTIONS.find((a) => a.id === s.id)!.label).join(" · ") || "nothing yet"}.</Note>
    </Demo>
  );
}

// ============================================================================ 2. Hole punching

type Classic = "full" | "restricted" | "port" | "symmetric";
const CLASSIC: Record<Classic, { mapping: MappingBehavior; filtering: FilteringBehavior }> = {
  full: { mapping: "eim", filtering: "eif" },
  restricted: { mapping: "eim", filtering: "adf" },
  port: { mapping: "eim", filtering: "apdf" },
  symmetric: { mapping: "apdm", filtering: "apdf" },
};
const CLASSIC_OPTS: [Classic, string][] = [["full", "full cone"], ["restricted", "restricted"], ["port", "port-restricted"], ["symmetric", "symmetric"]];
const HP = { a: seg("NAT A", CLASSIC_OPTS, "port"), b: seg("NAT B", CLASSIC_OPTS, "symmetric") };

export function NetIpHolePunchDemo() {
  const P = useParams("net-ip-punch", HP);
  const a = P.values.a as Classic, b = P.values.b as Classic;
  const r = useMemo(() => holePunch(CLASSIC[a], CLASSIC[b]), [a, b]);
  const matrix = useMemo(() => CLASSIC_OPTS.map(([x]) => CLASSIC_OPTS.map(([y]) => holePunch(CLASSIC[x], CLASSIC[y]).direct)), []);
  const w = r.world;
  const order = ["A", "NAT A", "Internet", "S", "NAT B", "B"].map((n) => w.node.get(n)!);
  const st = fromPackets(w.net, { nodes: order, label: (p) => p.payload.kind, color: (p) => (p.payload.kind === "punch" || p.payload.kind === "reply" ? "var(--c1)" : "var(--muted)") });
  const drops: StMark[] = w.log.filter((l) => l.tone === "drop").map((l) => ({ node: order.indexOf(l.node), t: l.t, shape: "cross", color: "var(--c4)" }));
  const tEnd = Math.ceil((w.net.now + 5) / 10) * 10;
  return (
    <Demo title="Two hosts behind NATs try to talk directly"
      controls={<>
        <Param spec={HP.a} value={a} onChange={(v) => P.set("a", v as "port")} />
        <Param spec={HP.b} value={b} onChange={(v) => P.set("b", v as "port")} />
      </>}
    >
      <SpaceTime nodes={order.map((n) => w.net.names[n]!)} tEnd={tEnd} messages={st.messages} marks={[...st.marks, ...drops]} rowHeight={36} />
      <Note>Grey: binding requests to the server S and its answers. Blue: punch packets and replies between A and B. A cross at a NAT: a packet the NAT dropped.</Note>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "S saw A as", value: r.seenA ? ep(r.seenA) : "–" },
          { label: "S saw B as", value: r.seenB ? ep(r.seenB) : "–" },
          { label: "A heard from B", value: r.aGot ? "yes" : "no" },
          { label: "B heard from A", value: r.bGot ? "yes" : "no" },
        ]} />
      </div>
      <Banner tone={r.direct ? "good" : "bad"}>
        {r.direct ? "Direct path open: both NATs now hold a mapping and a permit for the other side." : "No direct path. A real client would now fall back to a relay (TURN) and pay for every byte twice."}
      </Banner>
      <SectionLabel>Every pair (rows: NAT A, columns: NAT B)</SectionLabel>
      <MiniTable head={["", ...CLASSIC_OPTS.map(([, l]) => l)]}
        rows={CLASSIC_OPTS.map(([x, l], i) => [l, ...matrix[i]!.map((ok, j) => <span key={j} style={{ color: ok ? GOOD : BAD, fontWeight: x === a && CLASSIC_OPTS[j]![0] === b ? 700 : 400 }}>{ok ? "direct" : "relay"}</span>)])}
        highlight={CLASSIC_OPTS.findIndex(([x]) => x === a)} />
      <Note>NAT A is {classicName(CLASSIC[a].mapping, CLASSIC[a].filtering)}; host A is {formatIpv4(IP.hostA)} and NAT A's public address is {formatIpv4(IP.natA)}.</Note>
    </Demo>
  );
}
