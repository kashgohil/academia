/**
 * The Merkle tree of a Certificate Transparency log (RFC 6962, updated by RFC 9162 section 2.1), with real SHA-256.
 *
 * - A leaf hash is SHA-256(0x00 ‖ entry); an inner node is SHA-256(0x01 ‖ left ‖ right). The different prefixes stop
 *   an attacker from passing an inner node off as a leaf.
 * - For n entries, the left subtree holds the largest power of two smaller than n, so the tree only grows on the right.
 * - An inclusion proof (audit path) for entry m lists the sibling hashes from the leaf up: about log₂ n hashes.
 * - A consistency proof shows that the tree of size `first` is a prefix of the tree of size `second`: the log only
 *   appended entries and changed nothing.
 * The verification functions follow RFC 9162 sections 2.1.3.2 and 2.1.4.2 step by step.
 */
import { concat, equal, sha256, type Bytes } from "./crypto";

export const leafHash = (entry: Bytes) => sha256(concat(new Uint8Array([0]), entry));
export const nodeHash = (l: Bytes, r: Bytes) => sha256(concat(new Uint8Array([1]), l, r));

/** The largest power of two smaller than n (n ≥ 2). */
export function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH(D[n]): the Merkle Tree Hash of a list of entries. */
export function mth(entries: Bytes[]): Bytes {
  if (entries.length === 0) return sha256(new Uint8Array(0));
  if (entries.length === 1) return leafHash(entries[0]!);
  const k = splitPoint(entries.length);
  return nodeHash(mth(entries.slice(0, k)), mth(entries.slice(k)));
}

/** PATH(m, D[n]): the inclusion proof of entry m. */
export function inclusionProof(m: number, entries: Bytes[]): Bytes[] {
  const n = entries.length;
  if (n <= 1) return [];
  const k = splitPoint(n);
  if (m < k) return [...inclusionProof(m, entries.slice(0, k)), mth(entries.slice(k))];
  return [...inclusionProof(m - k, entries.slice(k)), mth(entries.slice(0, k))];
}

/** PROOF(m, D[n]): the consistency proof between the tree of the first m entries and the tree of all n. */
export function consistencyProof(m: number, entries: Bytes[]): Bytes[] {
  const sub = (m: number, d: Bytes[], b: boolean): Bytes[] => {
    const n = d.length;
    if (m === n) return b ? [] : [mth(d)];
    const k = splitPoint(n);
    if (m <= k) return [...sub(m, d.slice(0, k), b), mth(d.slice(k))];
    return [...sub(m - k, d.slice(k), false), mth(d.slice(0, k))];
  };
  return sub(m, entries, true);
}

const lsb = (x: number) => (x & 1) === 1;

/** RFC 9162 section 2.1.3.2. */
export function verifyInclusion(leaf: Bytes, index: number, treeSize: number, proof: Bytes[], root: Bytes): boolean {
  if (index >= treeSize) return false;
  let fn = index, sn = treeSize - 1, r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (lsb(fn) || fn === sn) {
      r = nodeHash(p, r);
      if (!lsb(fn)) while (!lsb(fn) && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else r = nodeHash(r, p);
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && equal(r, root);
}

/** RFC 9162 section 2.1.4.2. */
export function verifyConsistency(first: number, second: number, firstHash: Bytes, secondHash: Bytes, proof: Bytes[]): boolean {
  if (first === second) return proof.length === 0 && equal(firstHash, secondHash);
  if (proof.length === 0 || first <= 0 || first > second) return false;
  const path = (first & (first - 1)) === 0 ? [firstHash, ...proof] : [...proof];
  let fn = first - 1, sn = second - 1;
  while (lsb(fn)) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = path[0]!, sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (lsb(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!lsb(fn)) while (!lsb(fn) && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else sr = nodeHash(sr, c);
    fn >>= 1;
    sn >>= 1;
  }
  return equal(fr, firstHash) && equal(sr, secondHash) && sn === 0;
}

/** The number of hashes in PATH(m, D[n]), from the tree's shape alone (no hashing): about log₂ n. */
export function inclusionProofLength(m: number, n: number): number {
  if (n <= 1) return 0;
  const k = splitPoint(n);
  return 1 + (m < k ? inclusionProofLength(m, k) : inclusionProofLength(m - k, n - k));
}

/** A node of the drawn tree: the range of entries [lo, hi) it covers, its hash, and its children. */
export interface TreeNode {
  lo: number;
  hi: number;
  hash: Bytes;
  left?: TreeNode;
  right?: TreeNode;
  depth: number;
}

export function buildTree(entries: Bytes[], lo = 0, depth = 0): TreeNode {
  const n = entries.length;
  if (n === 1) return { lo, hi: lo + 1, hash: leafHash(entries[0]!), depth };
  const k = splitPoint(n);
  const left = buildTree(entries.slice(0, k), lo, depth + 1), right = buildTree(entries.slice(k), lo + k, depth + 1);
  return { lo, hi: lo + n, hash: nodeHash(left.hash, right.hash), left, right, depth };
}

/** The tree nodes whose hashes form the inclusion proof of entry m, as [lo, hi) ranges, from the leaf up. */
export function proofRanges(m: number, lo: number, hi: number): [number, number][] {
  const n = hi - lo;
  if (n <= 1) return [];
  const k = splitPoint(n);
  if (m < lo + k) return [...proofRanges(m, lo, lo + k), [lo + k, hi]];
  return [...proofRanges(m, lo + k, hi), [lo, lo + k]];
}

/** A log entry for the demo: the bytes stand in for a precertificate. */
export const ctEntry = (name: string, i: number) => new TextEncoder().encode(`precert #${i} for ${name}`);
