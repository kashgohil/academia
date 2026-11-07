/**
 * Revocation and certificate lifetimes.
 *
 * `exposure`: an attacker steals a server's private key. From that moment, how long can the attacker still
 * impersonate the server to a client that uses a given revocation method? The answer is the time until the client
 * stops accepting the certificate: the CA's delay to revoke, plus the time old "good" status stays cached, and never
 * more than the certificate's remaining lifetime. If the attacker sits on the client's path, it can block a status
 * fetch, and a client that "soft-fails" then accepts the certificate.
 *
 * All durations are model inputs except the Baseline Requirements limits quoted in comments.
 *
 * `MAX_VALIDITY`: the CA/Browser Forum schedule (ballot SC-081, Baseline Requirements section 6.3.2).
 */

export type RevMethod = "none" | "crl" | "ocsp" | "stapling" | "mustStaple" | "push" | "shortLived";

export const REV_LABEL: Record<RevMethod, string> = {
  none: "No revocation check",
  crl: "CRL, soft-fail",
  ocsp: "OCSP, soft-fail",
  stapling: "OCSP stapling",
  mustStaple: "OCSP Must-Staple",
  push: "Browser-pushed list",
  shortLived: "Short-lived certificate",
};

export interface ExposureOpts {
  /** Certificate lifetime in days. */
  lifetimeDays: number;
  /** When the key is stolen, as a fraction of the lifetime. */
  stolenAt: number;
  /** Hours from the theft until the CA revokes (the Baseline Requirements allow up to 24 h after the CA learns of a key compromise). */
  revokeDelayH: number;
  /** How long a CRL or an OCSP response stays valid and cached, in hours (the BRs allow up to 10 days). */
  statusValidityH: number;
  /** How often the browser vendor pushes a new revocation list, in hours. */
  pushIntervalH: number;
  /** The attacker controls the client's path and can block revocation fetches. */
  attackerOnPath: boolean;
  /** Lifetime of a short-lived certificate in hours (Let's Encrypt's shortlived profile: 160 hours). */
  shortLivedH: number;
}

export const EXPOSURE_DEFAULTS: ExposureOpts = { lifetimeDays: 90, stolenAt: 0.25, revokeDelayH: 24, statusValidityH: 168, pushIntervalH: 24, attackerOnPath: true, shortLivedH: 160 };

export interface Exposure {
  method: RevMethod;
  /** Hours the stolen key stays usable against this client. */
  hours: number;
  why: string;
}

export function exposure(o: ExposureOpts): Exposure[] {
  const lifeH = o.lifetimeDays * 24;
  const remaining = lifeH * (1 - o.stolenAt);
  const cap = (h: number) => Math.min(remaining, h);
  const cached = cap(o.revokeDelayH + o.statusValidityH);
  const out: Exposure[] = [];
  out.push({ method: "none", hours: remaining, why: "the certificate works until it expires" });
  out.push(o.attackerOnPath
    ? { method: "crl", hours: remaining, why: "the attacker blocks the CRL download; a soft-fail client goes on" }
    : { method: "crl", hours: cached, why: "revocation, then up to one CRL lifetime of cached \"good\"" });
  out.push(o.attackerOnPath
    ? { method: "ocsp", hours: remaining, why: "the attacker blocks the OCSP query; a soft-fail client goes on" }
    : { method: "ocsp", hours: cached, why: "revocation, then up to one OCSP response lifetime in the cache" });
  out.push({ method: "stapling", hours: remaining, why: "the attacker's server simply staples nothing; the client cannot tell" });
  out.push({ method: "mustStaple", hours: cached, why: "the attacker staples the last \"good\" response until it expires" });
  out.push({ method: "push", hours: cap(o.revokeDelayH + o.pushIntervalH), why: "revocation, then the next list update reaches the browser" });
  const sl = o.shortLivedH * (1 - o.stolenAt);
  out.push({ method: "shortLived", hours: sl, why: `no revocation at all: the certificate expires ${Math.round(sl)} h after the theft` });
  return out;
}

/** The maximum validity of a subscriber certificate by issue date (Baseline Requirements 6.3.2, ballot SC-081). */
export const MAX_VALIDITY: { from: string; days: number; dcvReuseDays: number }[] = [
  { from: "", days: 398, dcvReuseDays: 398 },
  { from: "2026-03-15", days: 200, dcvReuseDays: 200 },
  { from: "2027-03-15", days: 100, dcvReuseDays: 100 },
  { from: "2029-03-15", days: 47, dcvReuseDays: 10 },
];

export function maxValidity(isoDate: string): number {
  let d = MAX_VALIDITY[0]!.days;
  for (const s of MAX_VALIDITY) if (isoDate >= s.from) d = s.days;
  return d;
}

/** Renewals per year when a client renews after `renewFraction` of each certificate's lifetime (ACME clients often use 2/3). */
export const renewalsPerYear = (lifetimeDays: number, renewFraction = 2 / 3) => 365 / (lifetimeDays * renewFraction);
