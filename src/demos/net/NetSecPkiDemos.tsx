/** Demos for "Certificates and PKI": chain validation with one broken link, a Certificate Transparency log, and revocation. */
import { useMemo, useState } from "react";
import { Banner, Demo, Legend, Note, Param, SmallLabel, Stats, mono, range, select, seg, tint, toggle, useParams, useWidth } from "../../kit";
import { CheckList, shortHex } from "./NetSecUi";
import {
  PKI_BREAK_LABEL, REV_LABEL, buildTree, consistencyProof, ctEntry, exposure, inclusionProof, leafHash, mth, pkiScenario, proofRanges, validateChain,
  verifyConsistency, verifyInclusion, EXPOSURE_DEFAULTS, type Cert, type PkiBreak, type TreeNode,
} from "../../sims/net/security";

// ============================================================================ 1. Chain validation

const CH = {
  day: range({ label: "Day the client connects (leaf issued on day 0)", min: -10, max: 120, step: 1, default: 30 }),
  brk: select<PkiBreak>({ label: "Break one link", options: (Object.keys(PKI_BREAK_LABEL) as PkiBreak[]).map((k) => ({ value: k, label: PKI_BREAK_LABEL[k] })), default: "none" }),
  host: seg<"example.com" | "www.example.com" | "api.example.com">("Host the client asked for", [["example.com", "example.com"], ["www.example.com", "www.example.com"], ["api.example.com", "api.example.com"]], "www.example.com"),
  ct: toggle({ label: "Require Certificate Transparency (2 SCTs)", default: true }),
};

const CHECK_FIELD: Record<string, string> = {
  signature: "sig", validity: "validity", revocation: "serial", basicConstraints: "ca", "path length": "ca", keyUsage: "ku",
  name: "san", extendedKeyUsage: "eku", "Certificate Transparency": "scts", "find the issuer": "issuer", "trust anchor": "subject",
};

function CertCard({ c, bad, role, trusted }: { c: Cert; bad?: string; role: string; trusted: boolean }) {
  const row = (key: string, name: string, value: string) => (
    <div key={key} style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 6, padding: "1px 4px", borderRadius: 3, background: bad === key ? tint("var(--c4)", 30) : undefined }}>
      <span style={{ color: "var(--muted)" }}>{name}</span>
      <span style={{ ...mono, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
  return (
    <div style={{ border: `1.5px solid ${bad ? "var(--c4)" : "var(--border)"}`, borderRadius: 8, padding: "6px 6px 8px", fontSize: 12, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, padding: "0 4px 4px", fontWeight: 600 }}>
        <span>{role}</span>
        {trusted && <span style={{ color: "var(--c3)", fontWeight: 500 }}>in trust store</span>}
      </div>
      {row("subject", "subject", c.subject)}
      {row("issuer", "issuer", c.issuer)}
      {row("serial", "serial", `0x${c.serial.toString(16)}`)}
      {row("validity", "validity", `day ${c.notBefore} to ${c.notAfter}`)}
      {c.san.length > 0 && row("san", "SAN", c.san.join(", "))}
      {row("ca", "basicConstr.", c.ca ? `CA${c.pathLen !== undefined ? `, pathLen ${c.pathLen}` : ""}` : "not a CA")}
      {row("ku", "keyUsage", c.keyUsage.join(", "))}
      {c.eku.length > 0 && row("eku", "extKeyUsage", c.eku.join(", "))}
      {!c.ca && row("scts", "SCTs", String(c.scts))}
      {row("sig", "signature", `${c.sig.toString(16).slice(0, 12)}…`)}
    </div>
  );
}

export function NetSecChainDemo() {
  const P = useParams("net-sec-chain", CH);
  const { day, brk, host, ct } = P.values;
  const sc = useMemo(() => pkiScenario(brk), [brk]);
  const v = useMemo(() => validateChain(sc, { host, day, minScts: ct ? 2 : 0 }), [sc, host, day, ct]);
  const shown = v.path.length > 1 ? v.path : sc.presented;
  const roles = (i: number, n: number, c: Cert) => (i === 0 ? "leaf" : c.issuer === c.subject ? "root" : i === n - 1 && c.ca ? "root?" : "intermediate");
  const failedOn = v.failed?.cert;
  return (
    <Demo
      title="Validate a certificate chain, then break one link"
      controls={<>
        <Param spec={CH.day} value={day} onChange={(x) => P.set("day", x as number)} />
        <Param spec={CH.brk} value={brk} onChange={(x) => P.set("brk", x as PkiBreak)} />
        <Param spec={CH.host} value={host} onChange={(x) => P.set("host", x as "www.example.com")} />
        <Param spec={CH.ct} value={ct} onChange={(x) => P.set("ct", x as boolean)} />
      </>}
    >
      <SmallLabel>{v.path.length > 1 ? "The path the client built, leaf first" : "What the server sent"}</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
        {shown.map((c, i) => (
          <CertCard key={i} c={c} role={roles(i, shown.length, c)} trusted={sc.trustStore.some((t) => t.subject === c.subject && t.sig === c.sig)}
            bad={failedOn !== undefined && c.id === failedOn ? CHECK_FIELD[v.failed!.check] : undefined} />
        ))}
      </div>
      <SmallLabel style={{ marginTop: 10 }}>The checks, from the trust anchor down to the leaf</SmallLabel>
      <CheckList items={v.steps.map((s) => ({ label: `${s.cert}: ${s.check}`, detail: s.detail, ok: s.ok }))} />
      <Banner tone={v.ok ? "good" : "bad"}>{v.ok ? `The chain is valid for ${host} on day ${day}.` : `The client rejects the connection: ${v.failed!.check} fails on the ${v.failed!.cert}.`}</Banner>
      <Note>Signatures use a toy RSA key (62-bit modulus) over SHA-256 of the fields, so the demo can sign in a millisecond. Real chains use 2048-bit RSA or ECDSA P-256 over the DER bytes; the checks are the same.</Note>
    </Demo>
  );
}

// ============================================================================ 2. Certificate Transparency

const CT = {
  n: range({ label: "Entries in the log", min: 2, max: 16, step: 1, default: 7 }),
  m: range({ label: "Tree size a monitor saw earlier", min: 1, max: 16, step: 1, default: 4 }),
  rewrite: toggle({ label: "The log quietly rewrites entry 2", default: false }),
};

const NAMES = ["example.com", "bank.example", "shop.example", "mail.example", "news.example", "wiki.example", "api.example", "cdn.example", "blog.example", "docs.example", "pay.example", "auth.example", "img.example", "video.example", "status.example", "search.example"];

export function NetSecCtDemo() {
  const P = useParams("net-sec-ct", CT);
  const { n, rewrite } = P.values;
  const m = Math.min(P.values.m, n);
  const [leaf, setLeaf] = useState(1);
  const sel = Math.min(leaf, n - 1);
  const orig = useMemo(() => NAMES.slice(0, n).map((x, i) => ctEntry(x, i)), [n]);
  const entries = useMemo(() => (rewrite && n > 2 ? orig.map((e, i) => (i === 2 ? ctEntry("evil.example", 2) : e)) : orig), [orig, rewrite, n]);
  const tree = useMemo(() => buildTree(entries), [entries]);
  const root = tree.hash;
  // The monitor remembered the head of size m before any rewrite.
  const oldHead = useMemo(() => mth(orig.slice(0, m)), [orig, m]);
  const proof = inclusionProof(sel, entries);
  const incOk = verifyInclusion(leafHash(entries[sel]!), sel, n, proof, root);
  const cproof = consistencyProof(m, entries);
  const consOk = verifyConsistency(m, n, oldHead, root, cproof);
  const ranges = proofRanges(sel, 0, n);
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(300, width);
  const depth = Math.ceil(Math.log2(n));
  const H = (depth + 1) * 46 + 20;
  const nodes: TreeNode[] = [];
  const walk = (t: TreeNode) => { nodes.push(t); if (t.left) walk(t.left); if (t.right) walk(t.right); };
  walk(tree);
  const x = (t: TreeNode) => ((t.lo + t.hi) / 2 / n) * (W - 20) + 10;
  const y = (t: TreeNode) => (t.hi - t.lo === 1 ? depth : t.depth) * 46 + 18;
  const inProof = (t: TreeNode) => ranges.some(([a, b]) => a === t.lo && b === t.hi);
  const onPath = (t: TreeNode) => sel >= t.lo && sel < t.hi;
  const changedRange = (t: TreeNode) => rewrite && n > 2 && 2 >= t.lo && 2 < t.hi;
  return (
    <Demo
      title="A Certificate Transparency log: one Merkle tree, two proofs"
      controls={<>
        <Param spec={CT.n} value={n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={CT.m} value={P.values.m} onChange={(v) => P.set("m", v as number)} />
        <Param spec={CT.rewrite} value={rewrite} onChange={(v) => P.set("rewrite", v as boolean)} />
      </>}
    >
      <div ref={ref} style={{ width: "100%" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Merkle tree" style={{ display: "block" }}>
          {nodes.filter((t) => t.left).map((t, i) => (
            <g key={i}>
              {[t.left!, t.right!].map((c, j) => <line key={j} x1={x(t)} y1={y(t)} x2={x(c)} y2={y(c)} stroke={onPath(c) && onPath(t) ? "var(--c1)" : "var(--border)"} strokeWidth={onPath(c) && onPath(t) ? 2 : 1} />)}
            </g>
          ))}
          {nodes.map((t, i) => {
            const leafNode = t.hi - t.lo === 1;
            const color = inProof(t) ? "var(--c5)" : onPath(t) ? "var(--c1)" : "var(--muted)";
            return (
              <g key={i} onClick={leafNode ? () => setLeaf(t.lo) : undefined} style={{ cursor: leafNode ? "pointer" : undefined }}>
                <title>{`entries ${t.lo}..${t.hi - 1}: ${shortHex(t.hash, 8)}`}</title>
                <rect x={x(t) - (leafNode ? 11 : 9)} y={y(t) - 9} width={leafNode ? 22 : 18} height={18} rx={4}
                  fill={tint(color, inProof(t) || onPath(t) ? 40 : 10)} stroke={changedRange(t) ? "var(--c4)" : color} strokeWidth={changedRange(t) ? 2 : 1} strokeDasharray={changedRange(t) ? "3 2" : undefined} />
                {leafNode && <text x={x(t)} y={y(t) + 4} textAnchor="middle" fontSize="10.5" fill="var(--fg)">{t.lo}</text>}
              </g>
            );
          })}
          {m < n && <line x1={((m / n) * (W - 20)) + 10} x2={((m / n) * (W - 20)) + 10} y1={8} y2={H - 4} stroke="var(--c2)" strokeDasharray="4 3" />}
        </svg>
      </div>
      <Legend items={[{ label: "path from the chosen entry", color: "var(--c1)" }, { label: "hashes in its inclusion proof", color: "var(--c5)" }, { label: `old tree size ${m}`, color: "var(--c2)" }]} />
      <SmallLabel style={{ marginTop: 8 }}>Click a leaf. Entry {sel}: "{new TextDecoder().decode(entries[sel]!)}"</SmallLabel>
      <div style={{ ...mono, fontSize: 12, overflowWrap: "anywhere" }}>root hash (size {n}) = {shortHex(root, 10)}</div>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "hashes in the inclusion proof", value: proof.length },
          { label: "inclusion", value: incOk ? "verifies" : "fails" },
          { label: `consistency ${m} → ${n}`, value: consOk ? "verifies" : "fails" },
          { label: "hashes in that proof", value: cproof.length },
        ]} />
      </div>
      <Banner tone={consOk ? "good" : "bad"}>
        {consOk
          ? `The log proves, with ${cproof.length} hash${cproof.length === 1 ? "" : "es"}, that its tree of ${m} entries is a prefix of the tree of ${n}. It only appended.`
          : `The monitor's old head no longer matches: the log changed entry 2 after it published the tree of ${m}. Nobody can make a consistency proof for that.`}
      </Banner>
      <Note>Real SHA-256, leaf hash = SHA-256(0x00 ‖ entry), node = SHA-256(0x01 ‖ left ‖ right). The verification code follows RFC 9162, sections 2.1.3.2 and 2.1.4.2.</Note>
    </Demo>
  );
}

// ============================================================================ 3. Revocation

const RV = {
  life: range({ label: "Certificate lifetime", min: 7, max: 398, step: 1, default: 90, format: (v) => `${v} days` }),
  stolen: range({ label: "Key stolen at", min: 0, max: 0.95, step: 0.05, default: 0.25, format: (v) => `${Math.round(v * 100)}% of the lifetime` }),
  delay: range({ label: "CA revokes after (model input)", min: 1, max: 120, step: 1, default: 24, format: (v) => `${v} h` }),
  validity: range({ label: "CRL or OCSP response valid for (model input)", min: 8, max: 240, step: 8, default: 168, format: (v) => `${v} h` }),
  push: range({ label: "Browser list update every (model input)", min: 1, max: 72, step: 1, default: 24, format: (v) => `${v} h` }),
  onPath: toggle({ label: "The attacker is on the client's path (can block fetches)", default: true }),
};

export function NetSecRevocationDemo() {
  const P = useParams("net-sec-rev", RV);
  const { life, stolen, delay, validity, push, onPath } = P.values;
  const ex = exposure({ ...EXPOSURE_DEFAULTS, lifetimeDays: life, stolenAt: stolen, revokeDelayH: delay, statusValidityH: validity, pushIntervalH: push, attackerOnPath: onPath });
  const max = Math.max(...ex.map((e) => e.hours), 1);
  const fmt = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${Math.round(h)} h`);
  return (
    <Demo
      title="A stolen key: how long does it keep working?"
      controls={<>
        <Param spec={RV.life} value={life} onChange={(v) => P.set("life", v as number)} />
        <Param spec={RV.stolen} value={stolen} onChange={(v) => P.set("stolen", v as number)} />
        <Param spec={RV.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />
        <Param spec={RV.validity} value={validity} onChange={(v) => P.set("validity", v as number)} />
        <Param spec={RV.push} value={push} onChange={(v) => P.set("push", v as number)} />
        <Param spec={RV.onPath} value={onPath} onChange={(v) => P.set("onPath", v as boolean)} />
      </>}
    >
      <div style={{ display: "grid", gap: 8 }}>
        {ex.map((e) => (
          <div key={e.method}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
              <b style={{ fontWeight: 550 }}>{REV_LABEL[e.method]}{e.method === "shortLived" ? " (160 h)" : ""}</b>
              <span style={mono}>{fmt(e.hours)}</span>
            </div>
            <div style={{ height: 10, borderRadius: 3, background: "var(--subtle)", border: "1px solid var(--border)", overflow: "hidden", margin: "3px 0 2px" }}>
              <div style={{ width: `${(e.hours / max) * 100}%`, height: "100%", background: e.hours > 24 * 14 ? "var(--c4)" : e.hours > 72 ? "var(--c2)" : "var(--c3)" }} />
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{e.why}</div>
          </div>
        ))}
      </div>
      <Note>The bar is the time from the theft until this client rejects the certificate. Revocation never beats expiry: every bar stops at the end of the certificate's life.</Note>
    </Demo>
  );
}
