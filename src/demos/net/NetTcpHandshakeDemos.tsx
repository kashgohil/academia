/** Demos for "TCP handshake and teardown": a connection you can break, a SYN flood, SYN cookies, and TIME_WAIT. */
import { useMemo, useState } from "react";
import { Banner, Chip, Demo, Legend, Line, Param, Plot, RuleY, Stats, Note, SmallLabel, mono, range, seg, toggle, useParams, int } from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { HeaderDiagram } from "./PacketViews";
import { SegmentLog, StateStrip, tcpSpaceTime } from "./NetTcpUi";
import { COOKIE_MSS, COOKIE_PERIOD, checkCookie, cookieFields, handshakeRun, makeCookie, synFloodRun, timeWaitRun, type HsScenario, type TwScenario } from "../../sims/net/transport";

// ============================================================================ 1. A connection from start to end

const HS = {
  scenario: seg<HsScenario>("Scenario", [["normal", "Open, request, close"], ["halfclose", "Half-close"], ["simultaneous", "Simultaneous open"], ["refused", "Closed port"]], "normal"),
  delay: range({ label: "One-way delay", min: 2, max: 80, step: 1, default: 20, format: (v) => `${v} ms` }),
  syns: range({ label: "Lose the first SYNs", min: 0, max: 3, step: 1, default: 0, format: (v) => (v ? `${v}` : "none") }),
  synacks: range({ label: "Lose the first SYN-ACKs", min: 0, max: 2, step: 1, default: 0, format: (v) => (v ? `${v}` : "none") }),
  ack: toggle({ label: "Lose the third segment (the client's ACK)", default: false }),
};

const CAPTION: Record<HsScenario, string> = {
  normal: "SYN, SYN-ACK, ACK. The client sends a request, the server answers, the client closes first and waits in TIME_WAIT.",
  halfclose: "The client sends its request and closes its side at once (shutdown for writing). It still receives the whole answer in FIN_WAIT_2.",
  simultaneous: "Both sides send SYN at the same time. Each answers the other with SYN-ACK: four segments instead of three. Then both close at once, and both pass through CLOSING.",
  refused: "No socket listens on port 81. The server's stack answers the SYN with RST, and connect() fails with ECONNREFUSED.",
};

export function NetTcpHandshakeDemo() {
  const P = useParams("net-tcp-hs", HS);
  const { scenario, delay, syns, synacks, ack } = P.values;
  const run = useMemo(() => handshakeRun({ scenario: scenario as HsScenario, delay, lostSyns: syns, lostSynAcks: synacks, lostAck: ack }), [scenario, delay, syns, synacks, ack]);
  const [sel, setSel] = useState<number | undefined>();
  const st = tcpSpaceTime(run.net, { labels: "control", selected: sel });
  const tEnd = Math.max(10, run.lastPacket * 1.08);
  const names = run.conns.map((c) => `${run.net.names[c.node]}`);
  const c = run.conns[0]!;
  const rtt = 2 * delay;
  return (
    <Demo
      title="One TCP connection, segment by segment"
      controls={<>
        <Param spec={HS.scenario} value={scenario} onChange={(v) => { P.set("scenario", v as HsScenario); setSel(undefined); }} />
        <Param spec={HS.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />
        <Param spec={HS.syns} value={syns} onChange={(v) => P.set("syns", v as number)} />
        <Param spec={HS.synacks} value={synacks} onChange={(v) => P.set("synacks", v as number)} />
        <Param spec={HS.ack} value={ack} onChange={(v) => P.set("ack", v as boolean)} />
      </>}
    >
      <SpaceTime nodes={st.names} tEnd={tEnd} messages={st.messages} marks={st.marks} rowHeight={56} />
      <StateStrip tEnd={tEnd} rows={run.conns.map((x, i) => ({ name: names[i]!, states: x.states }))} />
      <Legend items={[{ label: "SYN", color: "var(--c2)" }, { label: "data", color: "var(--c1)" }, { label: "ACK", color: "var(--muted)" }, { label: "FIN", color: "var(--c5)" }, { label: "RST or retransmission", color: "var(--c4)" }]} />
      <Banner tone={c.reason === "refused" ? "bad" : syns || synacks ? "warn" : "plain"}>{CAPTION[scenario as HsScenario]}{syns || synacks ? ` A lost SYN or SYN-ACK costs a whole retransmission timeout: 1 s, then 2 s more.` : ""}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "client connected at", value: c.stats.establishedAt !== undefined ? `${int(c.stats.establishedAt)} ms` : "never" },
          { label: "in round trips", value: c.stats.establishedAt !== undefined ? (c.stats.establishedAt / rtt).toFixed(1) : "–" },
          { label: "segments", value: run.net.trace.filter((e) => e.kind === "send").length },
          { label: "client result", value: c.reason ?? c.state },
        ]} />
      </div>
      <div style={{ marginTop: 10 }}>
        <SegmentLog net={run.net} selected={sel} onSelect={setSel} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. SYN flood

const FL = {
  rate: range({ label: "Spoofed SYNs per second", min: 0, max: 1000, step: 10, default: 200 }),
  backlog: range({ label: "Half-open entries the listener keeps (model input)", min: 16, max: 1024, step: 16, default: 128 }),
  cookies: toggle({ label: "SYN cookies when the backlog is full", default: false }),
};

export function NetTcpSynFloodDemo() {
  const P = useParams("net-tcp-flood", FL);
  const { rate, backlog, cookies } = P.values;
  const r = useMemo(() => synFloodRun({ rate, backlog, cookies }), [rate, backlog, cookies]);
  const ok = r.attempts.filter((a) => a.done !== undefined).length;
  const maxY = Math.max(backlog * 1.15, 10);
  return (
    <Demo
      title="A SYN flood against one listener"
      controls={<>
        <Param spec={FL.rate} value={rate} onChange={(v) => P.set("rate", v as number)} />
        <Param spec={FL.backlog} value={backlog} onChange={(v) => P.set("backlog", v as number)} />
        <Param spec={FL.cookies} value={cookies} onChange={(v) => P.set("cookies", v as boolean)} />
      </>}
    >
      <Plot x={[0, 10]} y={[0, maxY]} height={200} xLabel="time (s)" yLabel="half-open entries">
        <RuleY at={backlog} label="backlog full" color="var(--c4)" />
        <Line points={r.halfOpen.map(([t, n]) => [t / 1000, n] as const)} color="var(--c2)" />
      </Plot>
      <SmallLabel style={{ marginTop: 8 }}>A real client tries to connect once a second (10 ms away). Each chip: when it started, and how long the connect took.</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {r.attempts.map((a, i) => (
          <Chip key={i} color={a.done !== undefined ? "var(--c3)" : "var(--c4)"}>{(a.start / 1000).toFixed(1)} s: {a.done !== undefined ? `${Math.round(a.done - a.start)} ms` : "no answer"}</Chip>
        ))}
      </div>
      <Banner tone={ok === r.attempts.length ? "good" : ok === 0 ? "bad" : "warn"}>
        {rate === 0 ? "No attack: every connect takes one round trip." : cookies
          ? `The backlog is still full of attack entries, but each new SYN gets a cookie instead of an entry. ${ok} of ${r.attempts.length} real connects succeed in one round trip.`
          : `The attack fills the backlog in ${(backlog / rate).toFixed(2)} s, and each entry stays for 63 s of SYN-ACK retries. ${ok} of ${r.attempts.length} real connects succeed.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "SYNs dropped", value: int(r.synsDropped) },
          { label: "cookies sent", value: int(r.cookiesSent) },
          { label: "cookies accepted", value: int(r.cookiesOk) },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 3. SYN cookie anatomy

const CK = {
  port: range({ label: "Client port", min: 32768, max: 33023, step: 1, default: 32800 }),
  mss: seg<string>("Client MSS option", [["536", "536"], ["1220", "1220"], ["1460", "1460"], ["8960", "8960"]], "1460"),
  age: range({ label: "ACK arrives after", min: 0, max: 200, step: 1, default: 0, format: (v) => `${v} s` }),
  forge: toggle({ label: "The ACK comes from an attacker who guesses", default: false }),
};

export function NetTcpCookieDemo() {
  const P = useParams("net-tcp-cookie", CK);
  const { port, mss, age, forge } = P.values;
  const SECRET = 0x5eed, CLIENT = 7, SERVER = 3, T_SYN = 100_000;
  const c = makeCookie(T_SYN, SECRET, CLIENT, port, SERVER, 80, Number(mss));
  const echoed = forge ? (c.isn ^ 0x00a5c3) >>> 0 : c.isn;
  const got = checkCookie(echoed, T_SYN + age * 1000, SECRET, CLIENT, port, SERVER, 80);
  const f = cookieFields(c.isn);
  const fields = [
    { name: "t mod 32", bits: 5, value: f.t, short: "t", note: "a counter that goes up every 64 s" },
    { name: "MSS index", bits: 3, value: f.idx, short: "MSS", note: `index into ${COOKIE_MSS.join(", ")}` },
    { name: "keyed hash of addresses, ports and t", bits: 24, value: f.hash, short: "hash", note: "the server's secret makes it unguessable" },
  ];
  const ageIntervals = Math.floor((T_SYN + age * 1000) / COOKIE_PERIOD) - Math.floor(T_SYN / COOKIE_PERIOD);
  return (
    <Demo
      title="A SYN cookie: the state hides in the sequence number"
      controls={<>
        <Param spec={CK.port} value={port} onChange={(v) => P.set("port", v as number)} />
        <Param spec={CK.age} value={age} onChange={(v) => P.set("age", v as number)} />
        <Param spec={CK.mss} value={mss} onChange={(v) => P.set("mss", v as string)} />
        <Param spec={CK.forge} value={forge} onChange={(v) => P.set("forge", v as boolean)} />
      </>}
    >
      <SmallLabel>The server's initial sequence number in its SYN-ACK = {c.isn} = 0x{c.isn.toString(16).padStart(8, "0")}</SmallLabel>
      <HeaderDiagram fields={fields} rowBits={32} values={[String(f.t), `${f.idx} → ${c.mss}`, `0x${f.hash.toString(16).padStart(6, "0")}`]} colors={["var(--c2)", "var(--c5)", "var(--c1)"]} />
      <div style={{ ...mono, fontSize: 12.5, margin: "8px 0", overflowWrap: "anywhere" }}>
        <span style={{ color: "var(--c2)" }}>{f.t.toString(2).padStart(5, "0")}</span>
        <span style={{ color: "var(--c5)" }}>{f.idx.toString(2).padStart(3, "0")}</span>
        <span style={{ color: "var(--c1)" }}>{f.hash.toString(2).padStart(24, "0")}</span>
      </div>
      <Banner tone={got !== undefined ? "good" : "bad"}>
        The ACK carries {echoed + 1}, so the server checks {echoed}.{" "}
        {got !== undefined
          ? `Valid: the server builds the connection now, with MSS ${got}. It never stored anything for the SYN.`
          : forge
            ? "The hash does not match: the attacker cannot compute it without the secret. The server answers with RST."
            : `Too old: ${ageIntervals} counter steps passed, and the server accepts only the current step and the one before. The server answers with RST.`}
      </Banner>
      <Note>The client's MSS is rounded down to a value in the table. Window scale and SACK from the SYN are lost, because nothing stored them. Linux packs its cookie differently (a counter that ticks every 60 s, SipHash), and keeps those options in the TCP timestamp when timestamps are on.</Note>
    </Demo>
  );
}

// ============================================================================ 4. TIME_WAIT

const TW = {
  scenario: seg<TwScenario>("Scenario", [["lastAck", "The last ACK is lost"], ["oldDup", "An old segment arrives late"]], "lastAck"),
  tw: toggle({ label: "TIME_WAIT (2 s here; a model input)", default: true }),
};

export function NetTcpTimeWaitDemo() {
  const P = useParams("net-tcp-tw", TW);
  const { scenario, tw } = P.values;
  const r = useMemo(() => timeWaitRun(scenario as TwScenario, tw), [scenario, tw]);
  const [sel, setSel] = useState<number | undefined>();
  const st = tcpSpaceTime(r.net, { labels: "control", selected: sel });
  const tEnd = Math.max(...r.net.hops.map((h) => h.arriveAt ?? h.txEnd)) * 1.06;
  let nc = 0, ns = 0;
  const rows = r.conns.map((c) => ({ name: c.node === 0 ? `client${nc++ ? " 2" : ""}` : `server${ns++ ? " 2" : ""}`, states: c.states }));
  let text: string, tone: "good" | "bad";
  if (scenario === "lastAck") {
    tone = r.serverEnd === "normal" ? "good" : "bad";
    text = tw
      ? "The server times out and sends FIN again. The client is still in TIME_WAIT, so it acknowledges it, and the server closes cleanly."
      : "The server sends FIN again, but the client has already forgotten the connection. Its stack answers with RST, and the server application sees ECONNRESET.";
  } else {
    tone = r.corrupted ? "bad" : "good";
    text = tw
      ? `TIME_WAIT still holds port 40000, so the second connection uses port ${r.port2}. The old segment matches no connection; the server answers it with RST.`
      : `Without TIME_WAIT the second connection reuses port 40000 with the same ISN. The old segment falls inside the new window, and the server accepts ${r.corrupted} bytes of the old connection as new data.`;
  }
  return (
    <Demo
      title="What TIME_WAIT protects against"
      controls={<>
        <Param spec={TW.scenario} value={scenario} onChange={(v) => { P.set("scenario", v as TwScenario); setSel(undefined); }} />
        <Param spec={TW.tw} value={tw} onChange={(v) => P.set("tw", v as boolean)} />
      </>}
    >
      <SpaceTime nodes={st.names} tEnd={tEnd} messages={st.messages} marks={st.marks} rowHeight={56} />
      <StateStrip tEnd={tEnd} rows={rows} />
      <Legend items={[{ label: "handshake", color: "var(--c2)" }, { label: "data", color: "var(--c1)" }, { label: "FIN", color: "var(--c5)" }, { label: "lost, retransmitted or RST", color: "var(--c4)" }]} />
      <Banner tone={tone}>{text}</Banner>
      <div style={{ marginTop: 10 }}>
        <SegmentLog net={r.net} selected={sel} onSelect={setSel} maxHeight={150} />
      </div>
    </Demo>
  );
}

