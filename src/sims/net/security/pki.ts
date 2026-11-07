/**
 * X.509 certificate chains and the validation a TLS client runs (RFC 5280 section 6.1, with the server-name rules of
 * RFC 9525 and the serverAuth extended key usage). The certificates carry the fields that validation reads. Each is
 * signed with a toy RSA key (crypto.ts) over a canonical text encoding of its fields: real certificates sign the DER
 * encoding of TBSCertificate with 2048-bit RSA or ECDSA, but the checks are the same.
 *
 * `pkiScenario` builds a chain with one link broken on purpose, and `validateChain` finds the break step by step.
 */
import { ascii, toyKey, toySign, toyVerify, type ToyKey } from "./crypto";

export interface Cert {
  /** A short id for the demo: root, int, leaf, … */
  id: string;
  serial: number;
  issuer: string;
  subject: string;
  /** Validity in days, relative to the day the leaf was issued (day 0). */
  notBefore: number;
  notAfter: number;
  /** subjectAltName dNSName entries. */
  san: string[];
  /** basicConstraints. */
  ca: boolean;
  pathLen?: number;
  keyUsage: string[];
  /** extendedKeyUsage (empty for CA certificates here). */
  eku: string[];
  /** The subject's public key. */
  pub: { n: bigint; e: bigint };
  /** Signed Certificate Timestamps from CT logs. */
  scts: number;
  /** The issuer's signature over `tbs(cert)`. */
  sig: bigint;
}

/** The bytes a certificate's signature covers: every field but the signature, in a fixed order. */
export function tbs(c: Omit<Cert, "sig" | "id">): Uint8Array {
  return ascii([
    `serial=${c.serial}`, `issuer=${c.issuer}`, `subject=${c.subject}`, `notBefore=${c.notBefore}`, `notAfter=${c.notAfter}`,
    `san=${c.san.join(",")}`, `ca=${c.ca}`, `pathLen=${c.pathLen ?? ""}`, `keyUsage=${c.keyUsage.join(",")}`,
    `eku=${c.eku.join(",")}`, `pub=${c.pub.n.toString(16)}:${c.pub.e}`, `scts=${c.scts}`,
  ].join("\n"));
}

export const KEYS = {
  root: toyKey("Lab Root X1", 2147483647n, 2147483579n),
  int: toyKey("Lab CA R1", 2147483563n, 2147483549n),
  leaf: toyKey("example.com", 2147483543n, 2147483497n),
  evil: toyKey("evil.example", 2147483489n, 2147483477n),
  rogue: toyKey("Rogue Root", 2147483629n, 2147483587n),
};

type Fields = Omit<Cert, "sig" | "pub" | "id"> & { id: string };
export function issue(f: Fields, subjectKey: ToyKey, issuerKey: ToyKey): Cert {
  const body = { ...f, pub: { n: subjectKey.n, e: subjectKey.e } };
  return { ...body, sig: toySign(issuerKey, tbs(body)) };
}

export const ROOT_NAME = "CN=Lab Root X1, O=Lab Trust", INT_NAME = "CN=Lab CA R1, O=Lab Trust", LEAF_NAME = "CN=example.com";

/** The leaf's lifetime in days (the classic 90-day ACME certificate). */
export const LEAF_DAYS = 90;

export function baseChain() {
  const root = issue({ id: "root", serial: 1, issuer: ROOT_NAME, subject: ROOT_NAME, notBefore: -3650, notAfter: 5475, san: [], ca: true, keyUsage: ["keyCertSign", "cRLSign"], eku: [], scts: 0 }, KEYS.root, KEYS.root);
  const int = issue({ id: "int", serial: 4096, issuer: ROOT_NAME, subject: INT_NAME, notBefore: -400, notAfter: 695, san: [], ca: true, pathLen: 0, keyUsage: ["keyCertSign", "cRLSign", "digitalSignature"], eku: [], scts: 0 }, KEYS.int, KEYS.root);
  const leaf = issue({ id: "leaf", serial: 0x3a7f21, issuer: INT_NAME, subject: LEAF_NAME, notBefore: 0, notAfter: LEAF_DAYS, san: ["example.com", "www.example.com"], ca: false, keyUsage: ["digitalSignature"], eku: ["serverAuth"], scts: 2 }, KEYS.leaf, KEYS.int);
  return { root, int, leaf };
}

export type PkiBreak = "none" | "tampered" | "intNotCa" | "leafSigns" | "missingInt" | "untrustedRoot" | "wrongEku" | "revoked" | "noScts";

export const PKI_BREAK_LABEL: Record<PkiBreak, string> = {
  none: "Nothing broken",
  tampered: "Leaf edited after signing",
  intNotCa: "Intermediate is not a CA",
  leafSigns: "A leaf signs another leaf",
  missingInt: "Server omits the intermediate",
  untrustedRoot: "Self-made root",
  wrongEku: "Leaf is for clients only",
  revoked: "Leaf is revoked",
  noScts: "Leaf has no SCTs",
};

export interface PkiScenario {
  /** What the server sends: the leaf first. */
  presented: Cert[];
  trustStore: Cert[];
  /** Serial numbers on the issuer's CRL. */
  revoked: Set<number>;
}

/** A chain with one link broken on purpose. */
export function pkiScenario(b: PkiBreak): PkiScenario {
  const { root, int, leaf } = baseChain();
  const store = [root];
  const sc: PkiScenario = { presented: [leaf, int], trustStore: store, revoked: new Set() };
  switch (b) {
    case "tampered":
      // Someone adds a name after the CA signed: the signature no longer matches the bytes.
      sc.presented = [{ ...leaf, san: [...leaf.san, "bank.example"] }, int];
      break;
    case "intNotCa": {
      const int2 = issue({ ...int, id: "int", ca: false, pathLen: undefined, keyUsage: ["digitalSignature"] }, KEYS.int, KEYS.root);
      sc.presented = [leaf, int2];
      break;
    }
    case "leafSigns": {
      // The attacker owns a valid leaf for evil.example and uses its key to sign a certificate for example.com.
      const evil = issue({ id: "evil", serial: 0x77e1, issuer: INT_NAME, subject: "CN=evil.example", notBefore: -10, notAfter: 80, san: ["evil.example"], ca: false, keyUsage: ["digitalSignature"], eku: ["serverAuth"], scts: 2 }, KEYS.evil, KEYS.int);
      const forged = issue({ id: "leaf", serial: 0x0bad, issuer: "CN=evil.example", subject: LEAF_NAME, notBefore: 0, notAfter: LEAF_DAYS, san: ["example.com"], ca: false, keyUsage: ["digitalSignature"], eku: ["serverAuth"], scts: 2 }, KEYS.leaf, KEYS.evil);
      sc.presented = [forged, evil, int];
      break;
    }
    case "missingInt":
      sc.presented = [leaf];
      break;
    case "untrustedRoot": {
      const rogue = issue({ id: "root", serial: 9, issuer: "CN=Rogue Root", subject: "CN=Rogue Root", notBefore: -10, notAfter: 3650, san: [], ca: true, keyUsage: ["keyCertSign"], eku: [], scts: 0 }, KEYS.rogue, KEYS.rogue);
      const forged = issue({ id: "leaf", serial: 0x0bad, issuer: "CN=Rogue Root", subject: LEAF_NAME, notBefore: 0, notAfter: LEAF_DAYS, san: ["example.com", "www.example.com"], ca: false, keyUsage: ["digitalSignature"], eku: ["serverAuth"], scts: 0 }, KEYS.leaf, KEYS.rogue);
      sc.presented = [forged, rogue];
      break;
    }
    case "wrongEku":
      sc.presented = [issue({ ...leaf, eku: ["clientAuth"] }, KEYS.leaf, KEYS.int), int];
      break;
    case "revoked":
      sc.revoked.add(leaf.serial);
      break;
    case "noScts":
      sc.presented = [issue({ ...leaf, scts: 0 }, KEYS.leaf, KEYS.int), int];
      break;
  }
  return sc;
}

export interface VStep {
  /** The certificate the step looks at. */
  cert: string;
  check: string;
  ok: boolean;
  detail: string;
}

export interface Validation {
  ok: boolean;
  /** The path that was built, leaf first; it ends at a trust anchor if one was found. */
  path: Cert[];
  steps: VStep[];
  /** The first failed step. */
  failed?: VStep;
}

/** Does `host` match the SAN entry `name`? A wildcard covers exactly one left-most label (RFC 9525 section 6.3). */
export function nameMatches(name: string, host: string): boolean {
  const n = name.toLowerCase(), h = host.toLowerCase();
  if (!n.startsWith("*.")) return n === h;
  const rest = n.slice(2);
  const dot = h.indexOf(".");
  return dot > 0 && h.slice(dot + 1) === rest;
}

export interface ValidateOpts {
  host: string;
  /** The day the client checks, relative to the leaf's issue day. */
  day: number;
  /** Require at least this many SCTs on the leaf (Chrome asks for 2 for a lifetime of 180 days or less). */
  minScts?: number;
}

/**
 * Builds a path from the leaf to a trust anchor, then checks it from the anchor down, as RFC 5280 section 6.1 does:
 * signature, validity, issuer name, revocation; for each CA: basicConstraints, keyUsage and path length. Then the
 * leaf: name match and extended key usage, and the CT policy.
 */
export function validateChain(sc: PkiScenario, o: ValidateOpts): Validation {
  const steps: VStep[] = [];
  const add = (cert: Cert, check: string, ok: boolean, detail: string) => (steps.push({ cert: cert.id, check, ok, detail }), ok);
  const done = (path: Cert[]): Validation => {
    const failed = steps.find((s) => !s.ok);
    return { ok: !failed, path, steps, failed };
  };
  // 1. Path building: follow issuer names through the presented certificates, then the trust store.
  const leaf = sc.presented[0]!;
  const path: Cert[] = [leaf];
  let cur = leaf;
  for (let i = 0; i < 6; i++) {
    const anchor = sc.trustStore.find((t) => t.subject === cur.issuer);
    if (anchor) {
      if (anchor !== cur) path.push(anchor);
      break;
    }
    const next = sc.presented.find((c) => c.subject === cur.issuer && c !== cur);
    if (!next) {
      add(cur, "find the issuer", false, `no certificate for "${cur.issuer}" was sent, and it is not a trusted root. ${cur.issuer === cur.subject ? "The chain ends in a self-signed root that is not in the trust store." : "The server must send the intermediate."}`);
      return done(path);
    }
    path.push(next);
    cur = next;
  }
  add(path[path.length - 1]!, "trust anchor", true, `"${path[path.length - 1]!.subject}" is in the trust store`);
  // 2. From the anchor down (RFC 5280 6.1.3 and 6.1.4). The anchor's key starts as the working key.
  let maxPath = path.length;
  for (let i = path.length - 2; i >= 0; i--) {
    const c = path[i]!, issuer = path[i + 1]!;
    const sigOk = toyVerify(issuer.pub, tbs(c), c.sig);
    if (!add(c, "signature", sigOk, sigOk ? `sigᵉ mod n matches the hash of the fields (key of "${issuer.subject}")` : `sigᵉ mod n does not match the hash of these fields: the bytes changed after "${issuer.subject}" signed them`)) return done(path);
    const inTime = o.day >= c.notBefore && o.day < c.notAfter;
    if (!add(c, "validity", inTime, inTime ? `day ${o.day} is within [${c.notBefore}, ${c.notAfter})` : o.day < c.notBefore ? `not valid before day ${c.notBefore}` : `expired on day ${c.notAfter}`)) return done(path);
    const rev = sc.revoked.has(c.serial);
    if (!add(c, "revocation", !rev, rev ? `serial 0x${c.serial.toString(16)} is on the CRL` : "not on the CRL")) return done(path);
    if (i === 0) break;
    // c will sign the next certificate down: it must be a CA, within the path length, allowed to sign certificates.
    if (!add(c, "basicConstraints", c.ca, c.ca ? "cA = TRUE" : `cA = FALSE: "${c.subject}" may not sign certificates`)) return done(path);
    if (!add(c, "path length", maxPath > 0, maxPath > 0 ? `${maxPath} more CA certificates allowed` : "too many CA certificates below a pathLenConstraint")) return done(path);
    maxPath--;
    if (c.pathLen !== undefined) maxPath = Math.min(maxPath, c.pathLen);
    const ku = c.keyUsage.includes("keyCertSign");
    if (!add(c, "keyUsage", ku, ku ? "keyCertSign is set" : "keyCertSign is missing")) return done(path);
  }
  // 3. The leaf.
  const match = leaf.san.find((n) => nameMatches(n, o.host));
  if (!add(leaf, "name", !!match, match ? `"${o.host}" matches the SAN entry "${match}"` : `"${o.host}" is not in the SAN list (${leaf.san.join(", ")}); the common name is not used`)) return done(path);
  const eku = leaf.eku.includes("serverAuth");
  if (!add(leaf, "extendedKeyUsage", eku, eku ? "serverAuth" : `only ${leaf.eku.join(", ")}: not for a TLS server`)) return done(path);
  if (o.minScts) add(leaf, "Certificate Transparency", leaf.scts >= o.minScts, leaf.scts >= o.minScts ? `${leaf.scts} SCTs` : `${leaf.scts} SCTs; the browser requires ${o.minScts}`);
  return done(path);
}
