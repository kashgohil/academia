/**
 * UNIX permission checks, as generic_permission() in fs/namei.c does them.
 * The key rule: the kernel picks exactly one class of bits (owner, group or other) and never looks at another.
 * This file also has the setuid rules for credentials, the sticky bit check and the setgid rule for new files.
 */
export const S_ISUID = 0o4000;
export const S_ISGID = 0o2000;
export const S_ISVTX = 0o1000;
export const MAY = { r: 4, w: 2, x: 1 } as const;
export type Want = keyof typeof MAY;
export type PermClass = "owner" | "group" | "other";

export interface Inode { uid: number; gid: number; mode: number; isDir?: boolean }

export interface Cred {
  ruid: number; euid: number; suid: number; fsuid: number;
  rgid: number; egid: number; sgid: number; fsgid: number;
  /** Supplementary groups. */
  groups: readonly number[];
  /** Capabilities that this check consults. Root has them because of its capability sets, not because of UID 0. */
  caps?: readonly ("CAP_DAC_OVERRIDE" | "CAP_DAC_READ_SEARCH" | "CAP_FOWNER" | "CAP_SETUID")[];
}

export const makeCred = (uid: number, gid: number, groups: readonly number[] = [], caps: Cred["caps"] = []): Cred =>
  ({ ruid: uid, euid: uid, suid: uid, fsuid: uid, rgid: gid, egid: gid, sgid: gid, fsgid: gid, groups, caps });

export const inGroup = (c: Cred, gid: number) => c.fsgid === gid || c.groups.includes(gid);

/** The single class of bits that applies. Owner beats group, and group beats other, even when the result is a denial. */
export const permClass = (i: Inode, c: Cred): PermClass => (c.fsuid === i.uid ? "owner" : inGroup(c, i.gid) ? "group" : "other");

const SHIFT: Record<PermClass, number> = { owner: 6, group: 3, other: 0 };
/** The three rwx bits of one class, as a number 0..7. */
export const classBits = (mode: number, cls: PermClass) => (mode >> SHIFT[cls]) & 7;

export interface PermStep { question: string; answer: boolean; note: string }
export interface PermResult {
  cls: PermClass;
  bits: number;
  need: number;
  /** The DAC bits allow it. */
  dacAllowed: boolean;
  allowed: boolean;
  /** The capability that overrode a denial, if one did. */
  override: "CAP_DAC_OVERRIDE" | "CAP_DAC_READ_SEARCH" | null;
  steps: PermStep[];
}

/** One access check. Follows the order of generic_permission: DAC bits first, then the capability overrides. */
export function checkPermission(i: Inode, c: Cred, want: Want | readonly Want[]): PermResult {
  const list: readonly Want[] = typeof want === "string" ? [want] : want;
  const need = list.reduce((a, w) => a | MAY[w], 0);
  const steps: PermStep[] = [];
  const isOwner = c.fsuid === i.uid;
  steps.push({ question: `fsuid ${c.fsuid} == file owner ${i.uid}?`, answer: isOwner, note: isOwner ? "Use the owner bits. The group and other bits are not read." : "Not the owner. Go to the next test." });
  let cls: PermClass = "owner";
  if (!isOwner) {
    const g = inGroup(c, i.gid);
    steps.push({ question: `File group ${i.gid} in {fsgid ${c.fsgid}${c.groups.length ? ", " + c.groups.join(", ") : ""}}?`, answer: g, note: g ? "Use the group bits. The other bits are not read." : "Not in the group. Use the other bits." });
    cls = g ? "group" : "other";
  }
  const bits = classBits(i.mode, cls);
  const dacAllowed = (bits & need) === need;
  steps.push({ question: `${cls} bits ${rwx(bits)} include ${rwx(need)}?`, answer: dacAllowed, note: dacAllowed ? "Access allowed." : "The bits deny it. Only a capability can still allow it." });
  let override: PermResult["override"] = null;
  if (!dacAllowed) {
    const has = (x: "CAP_DAC_OVERRIDE" | "CAP_DAC_READ_SEARCH") => c.caps?.includes(x) ?? false;
    const onlyRead = need === MAY.r;
    if (i.isDir) {
      if (!(need & MAY.w) && has("CAP_DAC_READ_SEARCH")) override = "CAP_DAC_READ_SEARCH";
      else if (has("CAP_DAC_OVERRIDE")) override = "CAP_DAC_OVERRIDE";
    } else {
      if (onlyRead && has("CAP_DAC_READ_SEARCH")) override = "CAP_DAC_READ_SEARCH";
      // An exec check needs at least one x bit somewhere in the mode.
      else if ((!(need & MAY.x) || (i.mode & 0o111) !== 0) && has("CAP_DAC_OVERRIDE")) override = "CAP_DAC_OVERRIDE";
    }
    steps.push({ question: "Does a capability override the denial?", answer: override !== null, note: override ? `${override} allows it.` : "No. The call returns EACCES." });
  }
  return { cls, bits, need, dacAllowed, allowed: dacAllowed || override !== null, override, steps };
}

export const rwx = (bits: number) => `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;

/** The first column and mode text of `ls -l`, including s, S, t and T. */
export function modeString(mode: number, isDir = false): string {
  const s = [rwx((mode >> 6) & 7), rwx((mode >> 3) & 7), rwx(mode & 7)].map((x) => x.split(""));
  const special = (set: string[], bit: number, lower: string, upper: string) => {
    if (mode & bit) set[2] = set[2] === "x" ? lower : upper;
  };
  special(s[0]!, S_ISUID, "s", "S");
  special(s[1]!, S_ISGID, "s", "S");
  special(s[2]!, S_ISVTX, "t", "T");
  return (isDir ? "d" : "-") + s.map((x) => x.join("")).join("");
}

/** check_sticky in the kernel, after the caller already has w+x on the directory. */
export function stickyAllowsDelete(dir: Inode, file: Inode, c: Cred): boolean {
  if (!(dir.mode & S_ISVTX)) return true;
  return c.fsuid === file.uid || c.fsuid === dir.uid || (c.caps?.includes("CAP_FOWNER") ?? false);
}

/** Can this process unlink a file from this directory? The file's own mode bits do not matter. */
export const mayDelete = (dir: Inode, file: Inode, c: Cred) =>
  checkPermission({ ...dir, isDir: true }, c, ["w", "x"]).allowed && stickyAllowsDelete(dir, file, c);

/** A setgid directory passes its group to new files. Otherwise the file gets the creator's fsgid. */
export const newFileGid = (dir: Inode, c: Cred) => (dir.mode & S_ISGID ? dir.gid : c.fsgid);

/** Credentials after execve of this file: the setuid and setgid bits. S_ISGID without group x is not a setgid program. */
export function execCred(c: Cred, file: Inode): Cred {
  const euid = file.mode & S_ISUID ? file.uid : c.euid;
  const egid = file.mode & S_ISGID && file.mode & 0o010 ? file.gid : c.egid;
  return { ...c, euid, suid: euid, fsuid: euid, egid, sgid: egid, fsgid: egid };
}

const privileged = (c: Cred) => c.euid === 0 || (c.caps?.includes("CAP_SETUID") ?? false);

/** setuid(2): a privileged caller sets all IDs, so the change is permanent. Others may set only the effective ID, to the real or saved ID. */
export function setuid(c: Cred, uid: number): Cred | "EPERM" {
  if (privileged(c)) return { ...c, ruid: uid, euid: uid, suid: uid, fsuid: uid };
  if (uid === c.ruid || uid === c.suid) return { ...c, euid: uid, fsuid: uid };
  return "EPERM";
}

/** seteuid(2): only the effective ID changes. This is how a setuid program drops privilege for a moment. */
export function seteuid(c: Cred, uid: number): Cred | "EPERM" {
  if (privileged(c) || uid === c.ruid || uid === c.suid || uid === c.euid) return { ...c, euid: uid, fsuid: uid };
  return "EPERM";
}
