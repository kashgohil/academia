/**
 * Linux capabilities and the execve transformation.
 * execveCaps follows cap_bprm_creds_from_file() in security/commoncap.c, in the same order:
 * file capabilities, the root special case, the no_new_privs limit, ambient clearing, then the final sets.
 */
export const CAP_NAMES = [
  "CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "LINUX_IMMUTABLE",
  "NET_BIND_SERVICE", "NET_BROADCAST", "NET_ADMIN", "NET_RAW", "IPC_LOCK", "IPC_OWNER", "SYS_MODULE", "SYS_RAWIO", "SYS_CHROOT", "SYS_PTRACE",
  "SYS_PACCT", "SYS_ADMIN", "SYS_BOOT", "SYS_NICE", "SYS_RESOURCE", "SYS_TIME", "SYS_TTY_CONFIG", "MKNOD", "LEASE", "AUDIT_WRITE",
  "AUDIT_CONTROL", "SETFCAP", "MAC_OVERRIDE", "MAC_ADMIN", "SYSLOG", "WAKE_ALARM", "BLOCK_SUSPEND", "AUDIT_READ", "PERFMON", "BPF",
  "CHECKPOINT_RESTORE",
] as const;
export type Cap = (typeof CAP_NAMES)[number];
export type CapSet = ReadonlySet<Cap>;

/** The capability number is its index in the table. CAP_LAST_CAP is 40 since Linux 5.9. */
export const capNumber = (c: Cap) => CAP_NAMES.indexOf(c);
export const CAP_COUNT = CAP_NAMES.length;
export const ALL_CAPS: CapSet = new Set(CAP_NAMES);
export const NO_CAPS: CapSet = new Set();

/** The capabilities that Docker keeps by default (from its documentation). Everything else is dropped. */
export const DOCKER_DEFAULT_CAPS: CapSet = new Set<Cap>([
  "CHOWN", "DAC_OVERRIDE", "FSETID", "FOWNER", "MKNOD", "NET_RAW", "SETGID", "SETUID", "SETFCAP", "SETPCAP", "NET_BIND_SERVICE", "SYS_CHROOT", "KILL", "AUDIT_WRITE",
]);

const inter = (a: CapSet, b: CapSet): CapSet => new Set([...a].filter((x) => b.has(x)));
const union = (a: CapSet, b: CapSet): CapSet => new Set([...a, ...b]);
const subset = (a: CapSet, b: CapSet) => [...a].every((x) => b.has(x));

export interface ProcCaps {
  ruid: number;
  euid: number;
  permitted: CapSet;
  effective: CapSet;
  inheritable: CapSet;
  bounding: CapSet;
  ambient: CapSet;
  noNewPrivs?: boolean;
}

export interface ExecFile {
  /** The file has the set-user-ID bit. */
  setuid?: boolean;
  /** Owner of the file. It matters only with the set-user-ID bit. */
  ownerUid?: number;
  /** File capabilities. Set `hasCaps` when the file has a security.capability attribute at all. */
  hasCaps?: boolean;
  fP?: CapSet;
  fI?: CapSet;
  fE?: boolean;
}

export interface ExecResult {
  next: ProcCaps;
  /** A file with file capabilities or a change of UID clears the ambient set. */
  privilegedFile: boolean;
  /** The file capabilities were replaced by "all ones" because the process is root. */
  rootRule: boolean;
  /** Each line says which rule gave which set. */
  trace: { set: string; formula: string; value: CapSet }[];
}

/** A process with no capabilities and a full bounding set, as for a normal login shell. */
export const plainProc = (uid: number, over: Partial<ProcCaps> = {}): ProcCaps =>
  ({ ruid: uid, euid: uid, permitted: NO_CAPS, effective: NO_CAPS, inheritable: NO_CAPS, bounding: ALL_CAPS, ambient: NO_CAPS, ...over });

/** The execve transformation for all five sets. */
export function execveCaps(p: ProcCaps, f: ExecFile): ExecResult {
  const nnp = p.noNewPrivs ?? false;
  const fP = f.hasCaps ? (f.fP ?? NO_CAPS) : NO_CAPS;
  const fI = f.hasCaps ? (f.fI ?? NO_CAPS) : NO_CAPS;
  const hasFcap = !!f.hasCaps;
  const trace: ExecResult["trace"] = [];

  // bprm_fill_uid: the set-user-ID bit, which no_new_privs ignores.
  const newEuid = f.setuid && !nnp ? (f.ownerUid ?? 0) : p.euid;
  const isSetid = newEuid !== p.euid;

  // get_file_caps
  let perm: CapSet = union(inter(p.bounding, fP), inter(p.inheritable, fI));
  let eff = hasFcap && !!f.fE;
  let formula = "(P(bounding) & F(permitted)) | (P(inheritable) & F(inheritable))";

  // handle_privileged_root. A set-user-ID-root file with file capabilities, run by a non-root user, skips the special case.
  const isSuidRoot = p.ruid !== 0 && newEuid === 0;
  let rootRule = false;
  if (!(hasFcap && isSuidRoot)) {
    if (newEuid === 0 || p.ruid === 0) {
      perm = union(p.bounding, p.inheritable);
      formula = "root: F(permitted) and F(inheritable) count as all ones, so P(bounding) | P(inheritable)";
      rootRule = true;
    }
    if (newEuid === 0) eff = true;
  }

  // no_new_privs: execve can never add a permitted capability.
  if (nnp && [...perm].some((c) => !p.permitted.has(c))) {
    perm = inter(perm, p.permitted);
    formula += ", then & P(permitted) because of no_new_privs";
  }

  const privilegedFile = hasFcap || isSetid;
  const ambient: CapSet = privilegedFile ? NO_CAPS : p.ambient;
  perm = union(perm, ambient);
  const effective: CapSet = eff ? perm : ambient;

  trace.push({ set: "ambient", formula: privilegedFile ? "privileged file: 0" : "P(ambient)", value: ambient });
  trace.push({ set: "permitted", formula: `${formula} | P'(ambient)`, value: perm });
  trace.push({ set: "effective", formula: eff ? "F(effective) is set: P'(permitted)" : "F(effective) is clear: P'(ambient)", value: effective });
  trace.push({ set: "inheritable", formula: "P(inheritable), unchanged", value: p.inheritable });
  trace.push({ set: "bounding", formula: "P(bounding), unchanged", value: p.bounding });

  return {
    next: { ...p, euid: newEuid, permitted: perm, effective, ambient },
    privilegedFile, rootRule, trace,
  };
}

/** The kernel's invariant: ambient is inside permitted and inside inheritable. Effective is inside permitted. */
export const capsInvariant = (p: ProcCaps) => subset(p.ambient, p.permitted) && subset(p.ambient, p.inheritable) && subset(p.effective, p.permitted);

/** prctl(PR_CAP_AMBIENT_RAISE): the capability must already be permitted and inheritable. */
export function ambientRaise(p: ProcCaps, c: Cap): ProcCaps | "EPERM" {
  if (!p.permitted.has(c) || !p.inheritable.has(c)) return "EPERM";
  return { ...p, ambient: union(p.ambient, new Set([c])) };
}

/** capable(): only the effective set answers. */
export const capable = (p: ProcCaps, c: Cap) => p.effective.has(c);

export const capList = (s: CapSet) => [...s].sort((a, b) => capNumber(a) - capNumber(b));
export const caps = (...c: Cap[]): CapSet => new Set(c);
