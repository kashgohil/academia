/** Demos for "TLS handshake": handshakes on the reference TCP, the key schedule, forward secrecy, the record layer, and an attacker on the path. */
import { useMemo, useState } from "react";
import { Banner, Chip, Demo, Legend, MiniTable, Note, Param, SmallLabel, Stats, int, mono, range, seg, select, tint, toggle, useParams } from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { fromPackets } from "./PacketViews";
import { CheckList, HexRuns, shortHex } from "./NetSecUi";
import {
  CT_ALERT, CT_APPLICATION, CT_HANDSHAKE, KX_LABEL, TLS_MODE_LABEL, ascii, openRecord, parseHello, recordNonce, rfc8448Keys, rfc8448Messages,
  rfc8448Schedule, sealRecord, secrecyRun, segmentMessages, tamperRun, tlsRun, toHex, uint, innerPlaintext,
  type HelloField, type KsNode, type KxMode, type Leak, type Tamper, type TlsMode,
} from "../../sims/net/security";
import type { Packet } from "../../sims/net";
import type { TcpSegment } from "../../sims/net/transport";

// ============================================================================ 1. Handshakes on TCP

const HS = {
  rtt: range({ label: "Round-trip time", min: 10, max: 200, step: 5, default: 50, format: (v) => `${v} ms` }),
  mode: select<TlsMode>({ label: "Handshake", options: (Object.keys(TLS_MODE_LABEL) as TlsMode[]).map((k) => ({ value: k, label: TLS_MODE_LABEL[k] })), default: "tls13" }),
  cert: range({ label: "Certificate chain (model input)", min: 1000, max: 24000, step: 500, default: 4000, format: (v) => `${(v / 1000).toFixed(1)} KB` }),
  pq: toggle({ label: "Hybrid post-quantum key share (X25519MLKEM768)", default: false }),
  lose: toggle({ label: "Lose the first segment of the server's flight", default: false }),
};

export function NetSecHandshakeDemo() {
  const P = useParams("net-sec-hs", HS);
  const { rtt, mode, cert, pq, lose } = P.values;
  const run = useMemo(() => tlsRun({ mode, rttMs: rtt, sizes: { certBytes: cert, pq }, loseServerSegment: lose }), [mode, rtt, cert, pq, lose]);
  const labelled = new Set<string>();
  const st = fromPackets(run.net, {
    label: (p: Packet<TcpSegment>) => {
      const s = p.payload;
      if (s.flags & 0x02) return s.flags & 0x10 ? undefined : "SYN";
      const ms = segmentMessages(run, p);
      const first = ms.find((m) => !labelled.has(m.id));
      if (!first) return undefined;
      ms.forEach((m) => labelled.add(m.id));
      return String(run.msgs.findIndex((t) => t.msg.id === first.id) + 1);
    },
    color: (p: Packet<TcpSegment>) => {
      const s = p.payload;
      if (s.flags & 0x02) return "var(--c5)";
      if (s.len === 0) return "var(--faint)";
      if (s.info.retx > 0) return "var(--c4)";
      const ms = segmentMessages(run, p);
      return ms.some((m) => m.vis === "plain") ? "var(--c2)" : "var(--c1)";
    },
  });
  const tEnd = (Number.isFinite(run.responseAt) ? run.responseAt : run.tEnd) * 1.06;
  const rows = run.msgs.map((t) => [
    <span key="m" style={{ color: t.msg.from === "c" ? "var(--fg)" : "var(--muted)" }}><b style={mono}>{run.msgs.indexOf(t) + 1}</b> {t.msg.from === "c" ? "→" : "←"} {t.msg.label}</span>,
    int(t.msg.bytes),
    `${t.sentAt.toFixed(0)}`,
    t.arrivedAt !== undefined ? `${t.arrivedAt.toFixed(0)}` : "–",
    <span key="s" style={{ color: t.msg.vis === "plain" ? "var(--c2)" : "var(--muted)" }}>{t.msg.sees}</span>,
  ]);
  return (
    <Demo
      title="A TLS handshake on the reference TCP"
      controls={<>
        <Param spec={HS.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
        <Param spec={HS.mode} value={mode} onChange={(v) => P.set("mode", v as TlsMode)} />
        <Param spec={HS.cert} value={cert} onChange={(v) => P.set("cert", v as number)} />
        <Param spec={HS.pq} value={pq} onChange={(v) => P.set("pq", v as boolean)} />
        <Param spec={HS.lose} value={lose} onChange={(v) => P.set("lose", v as boolean)} />
      </>}
    >
      <SpaceTime nodes={st.names} tEnd={tEnd} messages={st.messages} marks={st.marks} rowHeight={64} />
      <Legend items={[{ label: "TCP SYN", color: "var(--c5)" }, { label: "TLS, readable on the path", color: "var(--c2)" }, { label: "TLS, encrypted", color: "var(--c1)" }, { label: "pure ACK", color: "var(--faint)" }, { label: "retransmission", color: "var(--c4)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "TCP connected", value: `${run.tcpEstablishedAt.toFixed(0)} ms` },
          { label: "request leaves", value: `${run.requestAt.toFixed(0)} ms` },
          { label: "response complete", value: `${run.responseAt.toFixed(0)} ms` },
          { label: "round trips", value: run.rtts.toFixed(2) },
          { label: "server bytes", value: int(run.serverBytes) },
        ]} />
      </div>
      <div style={{ marginTop: 10 }}>
        <SmallLabel>Each arrow number is a TLS message; its first TCP segment carries the number.</SmallLabel>
        <MiniTable head={["message", "bytes", "sent (ms)", "arrived (ms)", "what the path sees"]} rows={rows} />
      </div>
      <Note>Sizes include the 5-byte record header, and for a protected TLS 1.3 record 1 byte of content type and a 16-byte tag. TCP starts with an initial window of 10 segments of 1460 bytes. No processing time.</Note>
    </Demo>
  );
}

// ============================================================================ 2. The key schedule

const KS = {
  hs: seg<"full" | "psk" | "pskonly">("Handshake", [["full", "Full (ECDHE)"], ["psk", "Resumed, psk_dhe_ke"], ["pskonly", "Resumed, psk_ke"]], "full"),
  flip: toggle({ label: "Flip one bit of the (EC)DHE shared secret", default: false }),
};

const KIND_COLOR: Record<KsNode["kind"], string> = { input: "var(--c5)", extract: "var(--c2)", derive: "var(--c1)", key: "var(--c3)" };
/** Rows of the RFC 8446 diagram: the spine node first, then its branches. */
const KS_ROWS: string[][] = [
  ["psk"], ["early", "binder", "cet", "cet-key"], ["derived1"], ["ecdhe"], ["hs", "chs", "chs-key", "shs", "shs-key", "sfin-key"], ["derived2"], ["ms", "cap", "cap-key", "sap", "sap-key", "exp", "res"],
];

export function NetSecKeyScheduleDemo() {
  const P = useParams("net-sec-ks", KS);
  const { hs, flip } = P.values;
  const base = useMemo(() => rfc8448Schedule(), []);
  const ks = useMemo(() => rfc8448Schedule({ withPsk: hs === "psk", pskOnly: hs === "pskonly", flipEcdheBit: flip ? 5 : undefined }), [hs, flip]);
  const [sel, setSel] = useState("hs");
  const byId = new Map(ks.map((n) => [n.id, n]));
  const changed = (id: string) => toHex(byId.get(id)!.value) !== toHex(base.find((n) => n.id === id)!.value);
  const nChanged = ks.filter((n) => changed(n.id)).length;
  const node = byId.get(sel)!;
  const box = (id: string) => {
    const n = byId.get(id)!;
    const c = KIND_COLOR[n.kind];
    const on = sel === id;
    return (
      <button key={id} onClick={() => setSel(id)} style={{
        textAlign: "left", cursor: "pointer", font: "inherit", padding: "5px 8px", borderRadius: 6, minWidth: 0,
        border: `1.5px solid ${on ? c : "var(--border)"}`, background: on ? tint(c, 26) : tint(c, 9), color: "var(--fg)",
        outline: changed(id) ? "2px dashed var(--c4)" : undefined, outlineOffset: 1,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" }}>{n.name}</div>
        <div style={{ ...mono, fontSize: 11, color: "var(--muted)" }}>{shortHex(n.value, 5)}</div>
      </button>
    );
  };
  return (
    <Demo
      title="The TLS 1.3 key schedule (RFC 8446, section 7.1), computed"
      controls={<>
        <Param spec={KS.hs} value={hs} onChange={(v) => P.set("hs", v as "full" | "psk" | "pskonly")} />
        <Param spec={KS.flip} value={flip} onChange={(v) => P.set("flip", v as boolean)} />
      </>}
    >
      <div style={{ display: "grid", gap: 6 }}>
        {KS_ROWS.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(135px, 1fr))", gap: 6, paddingLeft: r[0] === "ecdhe" || r[0] === "psk" ? 0 : 12, borderLeft: r[0] === "ecdhe" || r[0] === "psk" ? undefined : "2px solid var(--border)" }}>
            {r.map(box)}
          </div>
        ))}
      </div>
      <Legend items={[{ label: "input secret", color: KIND_COLOR.input }, { label: "HKDF-Extract", color: KIND_COLOR.extract }, { label: "Derive-Secret", color: KIND_COLOR.derive }, { label: "traffic key, IV", color: KIND_COLOR.key }]} />
      <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px" }}>
        <SmallLabel>{node.name}</SmallLabel>
        <div style={{ ...mono, fontSize: 12, overflowWrap: "anywhere" }}>{node.formula}</div>
        <div style={{ ...mono, fontSize: 12, overflowWrap: "anywhere", color: "var(--c1)", marginTop: 4 }}>{toHex(node.value)}</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>Protects: {node.use}.</div>
      </div>
      <Banner tone={nChanged === 0 ? "good" : "warn"}>
        {nChanged === 0
          ? "These are the secrets of the RFC 8448 trace, computed here with SHA-256, HMAC and HKDF in TypeScript. The tests compare each one with the RFC."
          : `${nChanged} of ${ks.length} values differ from the full handshake (dashed outline). ${flip ? "One flipped input bit changes every secret below the extract that takes it in, and nothing above it." : ""}`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 3. Forward secrecy

const FS = {
  mode: select<KxMode>({ label: "Key exchange", options: (Object.keys(KX_LABEL) as KxMode[]).map((k) => ({ value: k, label: KX_LABEL[k] })), default: "rsa12" }),
  leak: seg<Leak>("What leaks", [["cert", "Certificate key"], ["stek", "Ticket key (STEK)"]], "cert"),
  leakDay: range({ label: "Day of the leak", min: 1, max: 12, step: 1, default: 9 }),
  stek: range({ label: "New ticket key every (model input)", min: 0, max: 12, step: 1, default: 4, format: (v) => (v === 0 ? "never" : `${v} days`) }),
};

export function NetSecForwardSecrecyDemo() {
  const P = useParams("net-sec-fs", FS);
  const { mode, leak, leakDay, stek } = P.values;
  const ss = useMemo(() => secrecyRun({ mode, leak, leakDay, stekDays: stek }), [mode, leak, leakDay, stek]);
  const [sel, setSel] = useState(1);
  const s = ss[Math.min(sel, ss.length) - 1]!;
  const n = ss.filter((x) => x.exposed).length;
  return (
    <Demo
      title="Record now, decrypt later"
      controls={<>
        <Param spec={FS.mode} value={mode} onChange={(v) => P.set("mode", v as KxMode)} />
        <Param spec={FS.leak} value={leak} onChange={(v) => P.set("leak", v as Leak)} />
        <Param spec={FS.leakDay} value={leakDay} onChange={(v) => P.set("leakDay", v as number)} />
        <Param spec={FS.stek} value={stek} onChange={(v) => P.set("stek", v as number)} />
      </>}
    >
      <SmallLabel>One recorded connection per day. F: full handshake; R: resumed with the ticket from the day before. Click a day.</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 4 }}>
        {ss.map((x) => (
          <button key={x.day} onClick={() => setSel(x.day)} style={{
            cursor: "pointer", font: "inherit", padding: "6px 2px", borderRadius: 6, textAlign: "center",
            border: `1.5px solid ${sel === x.day ? "var(--fg)" : "var(--border)"}`, background: tint(x.exposed ? "var(--c4)" : "var(--c3)", x.exposed ? 40 : 16), color: "var(--fg)",
          }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>day {x.day}</div>
            <div style={{ ...mono, fontSize: 11, color: "var(--muted)" }}>{x.resumed ? "R" : "F"}{mode !== "rsa12" ? ` · STEK ${x.stek}` : ""}</div>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
        <b>Day {s.day}: {s.exposed ? "decrypted" : "still secret"}.</b> <span style={{ color: "var(--muted)" }}>{s.why.charAt(0).toUpperCase() + s.why.slice(1)}.</span>
        {s.dh && (
          <div style={{ ...mono, fontSize: 12, marginTop: 6, overflowWrap: "anywhere" }}>
            p = 2³¹ − 1, g = 7 (toy group) · a = {String(s.dh.a)}, b = {String(s.dh.b)} (deleted after the handshake)<br />
            A = gᵃ mod p = {String(s.dh.A)} · B = gᵇ mod p = {String(s.dh.B)} (on the wire)<br />
            secret = Bᵃ = Aᵇ mod p = {String(s.dh.secret)}
          </div>
        )}
        {s.rsa && (
          <div style={{ ...mono, fontSize: 12, marginTop: 6, overflowWrap: "anywhere" }}>
            premaster = {String(s.rsa.premaster)} · on the wire: premasterᵉ mod n = {String(s.rsa.encrypted)} (toy 62-bit RSA)
          </div>
        )}
      </div>
      <Banner tone={n === 0 ? "good" : "bad"}>{n} of {ss.length} recorded connections can be decrypted after the {leak === "cert" ? "certificate key" : "ticket key"} leaks on day {leakDay}.</Banner>
    </Demo>
  );
}

// ============================================================================ 4. The record layer

const RC = {
  seq: range({ label: "Sequence number of this record", min: 0, max: 7, step: 1, default: 0 }),
  pad: range({ label: "Zero padding", min: 0, max: 48, step: 1, default: 0, format: (v) => `${v} B` }),
  type: seg<"23" | "21" | "22">("Real content type", [["23", "application_data"], ["22", "handshake"], ["21", "alert"]], "23"),
  attack: seg<"none" | "flip" | "length" | "replay" | "reorder">("On the path", [["none", "Nothing"], ["flip", "Flip a ciphertext bit"], ["length", "Edit the length"], ["replay", "Replay"], ["reorder", "Reorder"]], "none"),
  at: range({ label: "Byte to flip", min: 0, max: 30, step: 1, default: 3 }),
};

export function NetSecRecordDemo() {
  const P = useParams("net-sec-rec", RC);
  const { seq, pad, type, attack, at } = P.values;
  const [text, setText] = useState("GET / HTTP/1.1");
  const k = useMemo(() => rfc8448Keys().clientApp, []);
  const content = ascii(text.slice(0, 64));
  const ct = Number(type);
  const rec = sealRecord(k.key, k.iv, seq, content, ct, pad);
  const wire = rec.slice();
  let expectSeq = seq;
  const flipAt = Math.min(at, wire.length - 6);
  if (attack === "flip") wire[5 + flipAt]! ^= 0x01;
  if (attack === "length") wire[4] = (wire[4]! - 1) & 0xff;
  if (attack === "replay") expectSeq = seq + 1; // the receiver already took this record
  if (attack === "reorder") expectSeq = seq === 0 ? 1 : seq - 1;
  // Editing the length: the attacker also cuts one byte, so the header still matches the record size.
  const sent = attack === "length" ? wire.slice(0, wire.length - 1) : wire;
  const res = openRecord(k.key, k.iv, expectSeq, sent);
  const nonce = recordNonce(k.iv, seq);
  const inner = innerPlaintext(content, ct, pad);
  const typeName = (t?: number) => (t === CT_APPLICATION ? "application_data" : t === CT_HANDSHAKE ? "handshake" : t === CT_ALERT ? "alert" : String(t));
  return (
    <Demo
      title="One TLS 1.3 record, sealed with AES-128-GCM"
      controls={<>
        <Param spec={RC.seq} value={seq} onChange={(v) => P.set("seq", v as number)} />
        <Param spec={RC.pad} value={pad} onChange={(v) => P.set("pad", v as number)} />
        <Param spec={RC.type} value={type} onChange={(v) => P.set("type", v as "23")} />
        <Param spec={RC.attack} value={attack} onChange={(v) => P.set("attack", v as "none")} />
        {attack === "flip" && <Param spec={RC.at} value={at} onChange={(v) => P.set("at", v as number)} />}
      </>}
    >
      <label style={{ display: "grid", gap: 4, fontSize: 12.5, color: "var(--muted)" }}>
        Plaintext
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={64} style={{ ...mono, fontSize: 13, padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--fg)", width: "100%", boxSizing: "border-box" }} />
      </label>
      <SmallLabel style={{ marginTop: 10 }}>TLSInnerPlaintext: content, then the real type, then zeros</SmallLabel>
      <HexRuns runs={[
        { label: "content", bytes: content, color: "var(--c1)" },
        { label: "type", bytes: inner.slice(content.length, content.length + 1), color: "var(--c5)" },
        ...(pad ? [{ label: "padding", bytes: inner.slice(content.length + 1), color: "var(--faint)" }] : []),
      ]} />
      <div style={{ ...mono, fontSize: 12, margin: "10px 0", overflowWrap: "anywhere", lineHeight: 1.6 }}>
        <div><span style={{ color: "var(--muted)" }}>iv     </span>{shortHex(k.iv, 12)}</div>
        <div><span style={{ color: "var(--muted)" }}>seq    </span>{shortHex(uint(seq, 12), 12)}</div>
        <div><span style={{ color: "var(--muted)" }}>nonce  </span>{shortHex(nonce, 12)} <span style={{ color: "var(--muted)" }}>(iv XOR seq)</span></div>
      </div>
      <SmallLabel>The record on the wire{attack !== "none" ? ", after the attacker" : ""}</SmallLabel>
      <HexRuns runs={[
        { label: "header (AAD)", bytes: sent.slice(0, 5), color: "var(--c2)", mark: attack === "length" ? [4] : [] },
        { label: "ciphertext", bytes: sent.slice(5, sent.length - 16), color: "var(--c1)", mark: attack === "flip" && flipAt < sent.length - 21 ? [flipAt] : [] },
        { label: "tag", bytes: sent.slice(sent.length - 16), color: "var(--c3)", mark: attack === "flip" && flipAt >= sent.length - 21 ? [flipAt - (sent.length - 21)] : [] },
      ]} />
      <Banner tone={res.ok ? "good" : "bad"}>
        {res.ok
          ? `The receiver expects sequence number ${expectSeq}, builds the same nonce, and the tag verifies. It strips ${res.pad} zero bytes and finds type ${typeName(res.type)}: "${new TextDecoder().decode(res.content)}".`
          : `The receiver expects sequence number ${expectSeq}. ${res.why}. It sends a bad_record_mac alert and closes the connection.`}
      </Banner>
      <Note>Key and IV: the client application traffic key of the RFC 8448 trace. With the plaintext of that trace, this code produces its 72-byte record byte for byte. The outer header always says application_data (23) and version 0x0303, so the path does not learn the real type.</Note>
    </Demo>
  );
}

// ============================================================================ 5. An attacker on the path

const TP = {
  t: select<Tamper>({ label: "The attacker", options: [
    { value: "none", label: "only forwards packets" },
    { value: "sni", label: "rewrites the SNI in ClientHello" },
    { value: "flipbyte", label: "flips one bit of ClientHello.random" },
    { value: "keyshare", label: "swaps in its own key share" },
    { value: "downgrade", label: "strips TLS 1.3 (downgrade)" },
  ], default: "keyshare" }),
};

export function NetSecTamperDemo() {
  const P = useParams("net-sec-tamper", TP);
  const { t } = P.values;
  const r = useMemo(() => tamperRun(t), [t]);
  const M = useMemo(() => rfc8448Messages(), []);
  const fieldsCh = parseHello(r.clientHello), fieldsSh = parseHello(r.serverHello);
  // A field changed if its bytes differ from the original message.
  const diff = (fs: HelloField[], a: Uint8Array, b: Uint8Array) => fs.map((f) => toHex(a.slice(f.offset, f.offset + f.len)) !== toHex(b.slice(f.offset, f.offset + f.len)));
  const dCh = diff(fieldsCh, r.clientHello, M.ch), dSh = diff(fieldsSh, r.serverHello, M.sh);
  const table = (fs: HelloField[], d: boolean[]) => (
    <div style={{ display: "grid", fontSize: 12.5, border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
      {fs.map((f, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 42%) 1fr", gap: 8, padding: "3px 8px", borderTop: i ? "1px solid var(--border)" : undefined, background: d[i] ? tint("var(--c4)", 20) : undefined }}>
          <span style={{ color: d[i] ? "var(--c4)" : undefined, fontWeight: d[i] ? 600 : 400, overflowWrap: "anywhere", minWidth: 0 }}>{f.name} <span style={{ color: "var(--faint)" }}>{f.len} B</span></span>
          <span style={{ ...mono, fontSize: 11.5, color: d[i] ? "var(--fg)" : "var(--muted)", overflowWrap: "anywhere" }}>{f.value}</span>
        </div>
      ))}
    </div>
  );
  const reached: { label: string; ok?: boolean; detail?: string }[] = [
    { label: "downgrade sentinel" }, { label: "decrypt EncryptedExtensions … Finished" }, { label: "CertificateVerify signature" }, { label: "server Finished" },
  ].map((c) => {
    const got = r.checks.find((x) => x.step === c.label);
    return got ? { label: c.label, ok: got.ok, detail: got.detail } : c;
  });
  return (
    <Demo title="An attacker on the path changes the handshake" controls={<Param spec={TP.t} value={t} onChange={(v) => P.set("t", v as Tamper)} />}>
      <SmallLabel>The attacker {r.change}.</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
        <div><SmallLabel>ClientHello as the server gets it (RFC 8448 trace)</SmallLabel>{table(fieldsCh, dCh)}</div>
        <div><SmallLabel>ServerHello as the client gets it</SmallLabel>{table(fieldsSh, dSh)}</div>
      </div>
      <SmallLabel style={{ marginTop: 10 }}>The client's checks, in order, on real bytes</SmallLabel>
      <CheckList items={reached} />
      <Banner tone={r.safe ? "good" : r.compromised ? "bad" : "warn"}>
        {r.safe ? "Every check passes: the client talks to the real server, and nothing was changed." : r.compromised ? "The handshake completes with the attacker." : "The client aborts the handshake. The attacker can block the connection, but it cannot read or change it."}
      </Banner>
      <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Chip color="var(--muted)">X25519, AES-128-GCM, RSA-PSS: real code</Chip>
        <Chip color="var(--muted)">keys and messages: RFC 8448</Chip>
      </div>
    </Demo>
  );
}
