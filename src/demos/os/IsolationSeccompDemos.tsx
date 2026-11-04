/** Demos for "seccomp and sandboxing": a filter builder with a real classic BPF run, and the system call surface. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, select, toggle, useParams } from "../../kit";
import {
  AUDIT_ARCH, ERRNO, PROFILES, PROGRAMS, SYSCALLS, compile, disasm, nrOf, profileAllows, run, surfaceReport, validate, type ActionName, type Insn, type ProfileId, type RuleAction, type SeccompData, type SysGroup,
} from "../../sims/os/isolation";
import { Badge, Card, Note, Scroll, Verdict, mono, seg, smallTable, td, twoCol, type Tone } from "./IsolationUi";

interface UiRule { id: number; sys: string; action: ActionId; arg?: "none" | "notunix" | "newuser" }
type ActionId = "allow" | "errno" | "trap" | "kill" | "notify" | "log";

const ACTIONS: { id: ActionId; label: string; act: RuleAction }[] = [
  { id: "allow", label: "ALLOW", act: { kind: "allow" } },
  { id: "errno", label: "ERRNO(EPERM)", act: { kind: "errno", errno: ERRNO.EPERM } },
  { id: "trap", label: "TRAP (SIGSYS)", act: { kind: "trap" } },
  { id: "kill", label: "KILL_PROCESS", act: { kind: "kill" } },
  { id: "notify", label: "USER_NOTIF", act: { kind: "notify" } },
  { id: "log", label: "LOG", act: { kind: "log" } },
];
const actOf = (id: ActionId) => ACTIONS.find((a) => a.id === id)!.act;

const AF_UNIX = 1, AF_INET = 2;
const CLONE_NEWUSER = 0x10000000, CLONE_THREAD_ETC = 0x50f00;

interface Call { label: string; sys: string; d: SeccompData; note?: string }
const X86 = AUDIT_ARCH.X86_64;
const call = (label: string, sys: string, args: bigint[], note?: string, arch: number = X86, nrOver?: number): Call => ({ label, sys, note, d: { nr: nrOver ?? nrOf(sys), arch, args } });
const TRACE: Call[] = [
  call("read(3, buf, 4096)", "read", [3n, 0x7ffd0000n, 4096n]),
  call("write(1, msg, 12)", "write", [1n, 0x55550000n, 12n]),
  call('openat(AT_FDCWD, "/etc/shadow", O_RDONLY)', "openat", [BigInt.asUintN(64, -100n), 0x7ffd1234n, 0n], "The filter sees the pointer 0x7ffd1234. It cannot read the path string."),
  call("socket(AF_UNIX, SOCK_STREAM, 0)", "socket", [BigInt(AF_UNIX), 1n, 0n]),
  call("socket(AF_INET, SOCK_STREAM, 0)", "socket", [BigInt(AF_INET), 1n, 0n]),
  call("clone(CLONE_THREAD | ...)", "clone", [BigInt(CLONE_THREAD_ETC), 0n, 0n], "Thread creation."),
  call("clone(CLONE_NEWUSER)", "clone", [BigInt(CLONE_NEWUSER), 0n, 0n], "Flags are an integer, so a filter can test them."),
  call("execve(\"/bin/sh\", ...)", "execve", [0x55551000n, 0n, 0n]),
  call("mount(...)", "mount", [0n, 0n, 0n]),
  call("exit_group(0)", "exit_group", [0n]),
  call("read, through the 32-bit entry", "read", [3n, 0n, 0n], "Same number 0 on the i386 table means restart_syscall. The arch check stops this confusion.", 0x40000003, 0),
];

const SYS_OPTS = ["read", "write", "openat", "socket", "clone", "execve", "mount", "exit_group", "mmap", "futex", "ptrace", "bpf"];

const PRESETS: { id: string; label: string; rules: Omit<UiRule, "id">[]; fallback: ActionId }[] = [
  { id: "allow", label: "Allow list", fallback: "kill", rules: [{ sys: "read", action: "allow" }, { sys: "write", action: "allow" }, { sys: "exit_group", action: "allow" }] },
  { id: "deny", label: "Deny list", fallback: "allow", rules: [{ sys: "mount", action: "errno" }, { sys: "execve", action: "errno" }, { sys: "ptrace", action: "kill" }] },
  { id: "args", label: "Argument checks", fallback: "allow", rules: [{ sys: "socket", action: "errno", arg: "notunix" }, { sys: "clone", action: "errno", arg: "newuser" }] },
  { id: "notify", label: "Ask a supervisor", fallback: "allow", rules: [{ sys: "openat", action: "notify" }, { sys: "mount", action: "trap" }] },
];

const VERDICT: Record<ActionName, { tone: Tone; text: string }> = {
  allow: { tone: "good", text: "ALLOW: the call runs." },
  log: { tone: "good", text: "LOG: the call runs, and the kernel records it." },
  errno: { tone: "warn", text: "ERRNO: the call does not run, and it returns the error." },
  trap: { tone: "warn", text: "TRAP: the task gets SIGSYS. A handler can emulate the call." },
  user_notif: { tone: "info", text: "USER_NOTIF: the task waits, and a supervisor process decides." },
  trace: { tone: "info", text: "TRACE: a ptrace tracer decides." },
  kill_thread: { tone: "bad", text: "KILL_THREAD: the thread dies." },
  kill_process: { tone: "bad", text: "KILL_PROCESS: the whole process dies with SIGSYS." },
};

const selStyle: React.CSSProperties = { fontSize: 12.5, maxWidth: "100%" };
let nextId = 100;

export function IsolationFilterDemo() {
  const [rules, setRules] = useState<UiRule[]>(() => PRESETS[0]!.rules.map((r) => ({ ...r, id: nextId++ })));
  const [fallback, setFallback] = useState<ActionId>("kill");
  const [preset, setPreset] = useState("allow");
  const [callIx, setCallIx] = useState(2);
  const [stepAt, setStepAt] = useState<number | null>(null);
  const prog: Insn[] = useMemo(() => compile({
    rules: rules.map((r) => ({
      nr: nrOf(r.sys), action: actOf(r.action),
      when: r.arg === "notunix" ? { arg: 0, op: "ne" as const, value: AF_UNIX } : r.arg === "newuser" ? { arg: 0, op: "set" as const, value: CLONE_NEWUSER } : undefined,
    })),
    fallback: actOf(fallback),
  }), [rules, fallback]);
  const bad = validate(prog);
  const results = useMemo(() => (bad ? [] : TRACE.map((c) => run(prog, c.d))), [prog, bad]);
  const cur = results[callIx];
  const steps = cur?.steps ?? [];
  const at = Math.min(stepAt ?? steps.length - 1, steps.length - 1);
  const st = steps[at];
  const visited = new Set(steps.slice(0, at + 1).map((s) => s.pc));
  const change = (f: () => void) => { f(); setPreset(""); setStepAt(null); };
  const c = TRACE[callIx]!;
  return (
    <Demo title="Build a seccomp filter and run a trace through it">
      <div className="seg" style={{ marginBottom: 8 }}>
        {PRESETS.map((p) => <button key={p.id} className={preset === p.id ? "on" : ""} onClick={() => { setRules(p.rules.map((r) => ({ ...r, id: nextId++ }))); setFallback(p.fallback); setPreset(p.id); setStepAt(null); }}>{p.label}</button>)}
      </div>
      <div style={twoCol}>
        <Card title="Rules: the first match wins">
          {rules.map((r, i) => (
            <div key={r.id} className="row" style={{ gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
              <select aria-label="system call" style={selStyle} value={r.sys} onChange={(e) => change(() => setRules(rules.map((x, j) => j === i ? { ...x, sys: e.target.value, arg: undefined } : x)))}>
                {SYS_OPTS.map((s) => <option key={s}>{s}</option>)}
              </select>
              <select aria-label="action" style={selStyle} value={r.action} onChange={(e) => change(() => setRules(rules.map((x, j) => j === i ? { ...x, action: e.target.value as ActionId } : x)))}>
                {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
              {r.arg === "notunix" && <span className="muted" style={{ ...mono, fontSize: 11 }}>if args[0] != AF_UNIX</span>}
              {r.arg === "newuser" && <span className="muted" style={{ ...mono, fontSize: 11 }}>if args[0] &amp; CLONE_NEWUSER</span>}
              <button className="btn ghost" style={{ padding: "0 6px" }} aria-label="remove rule" onClick={() => change(() => setRules(rules.filter((_, j) => j !== i)))}>remove</button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 6, gap: 6 }}>
            <button className="btn" onClick={() => change(() => setRules([...rules, { id: nextId++, sys: "openat", action: "allow" }]))}>Add rule</button>
            <label className="row" style={{ gap: 4, fontSize: 12.5 }}><span className="muted">Otherwise</span>
              <select style={selStyle} value={fallback} onChange={(e) => change(() => setFallback(e.target.value as ActionId))}>
                {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
          </div>
        </Card>
        <Card title="The trace: click a call to step through it">
          <Scroll style={{ maxHeight: 220, overflowY: "auto" }}>
            <table style={smallTable}><tbody>
              {TRACE.map((t, i) => {
                const r = results[i];
                const v = r ? VERDICT[r.action] : null;
                return (
                  <tr key={i} onClick={() => { setCallIx(i); setStepAt(0); }} style={{ cursor: "pointer", background: i === callIx ? "var(--subtle)" : undefined }}>
                    <td style={{ ...td, ...mono, fontSize: 11.5 }}>{t.label}</td>
                    <td style={{ ...td, textAlign: "right" }}>{v && <Badge tone={v.tone}>{r!.action === "errno" ? "errno" : r!.action.replace("_", " ")}</Badge>}</td>
                  </tr>
                );
              })}
            </tbody></table>
          </Scroll>
        </Card>
      </div>
      <div style={{ ...twoCol, marginTop: 10 }}>
        <Card title={`Classic BPF: ${prog.length} instructions`}>
          <Scroll style={{ maxHeight: 240, overflowY: "auto" }}>
            {prog.map((ins, pc) => {
              const here = st?.pc === pc;
              return (
                <div key={pc} style={{ ...mono, fontSize: 11.5, whiteSpace: "pre", padding: "1px 4px", background: here ? "var(--fg)" : visited.has(pc) ? "var(--subtle)" : undefined, color: here ? "var(--bg)" : visited.has(pc) ? "var(--fg)" : "var(--muted)" }}>
                  {String(pc).padStart(3, " ")}  {disasm(ins, pc)}
                </div>
              );
            })}
          </Scroll>
        </Card>
        <Card title="The run">
          <div style={{ ...mono, fontSize: 12, overflowWrap: "anywhere" }}>{c.label}</div>
          <div style={{ ...mono, fontSize: 11.5, marginTop: 4 }} className="muted">nr = {c.d.nr}, arch = 0x{(c.d.arch >>> 0).toString(16)}{c.d.args?.[0] !== undefined ? `, args[0] = 0x${c.d.args[0]!.toString(16)}` : ""}</div>
          {c.note && <Note>{c.note}</Note>}
          <div className="row" style={{ margin: "8px 0" }}>
            <button className="btn" disabled={at <= 0} onClick={() => setStepAt(Math.max(0, at - 1))}>Back</button>
            <button className="btn primary" disabled={at >= steps.length - 1} onClick={() => setStepAt(at + 1)}>Step</button>
            <span className="muted" style={{ fontSize: 12 }}>{at + 1} of {steps.length}</span>
          </div>
          {st && <div style={{ ...mono, fontSize: 12 }}>pc = {st.pc}<br />A = 0x{(st.a >>> 0).toString(16)}, X = 0x{(st.x >>> 0).toString(16)}<br /><span className="muted">{st.note}</span></div>}
          {cur && at === steps.length - 1 && <Verdict tone={VERDICT[cur.action].tone}>{VERDICT[cur.action].text}</Verdict>}
        </Card>
      </div>
    </Demo>
  );
}

// ---------------- system call surface ----------------

const GROUP_LABEL: Record<SysGroup, string> = { file: "Files and descriptors", memory: "Memory", process: "Processes", signal: "Signals", time: "Time", network: "Network", ipc: "System V IPC", admin: "Administration", sandbox: "Namespaces and sandbox" };
const GROUPS = Object.keys(GROUP_LABEL) as SysGroup[];

export function IsolationSurfaceDemo() {
  const P = useParams("iso-surface", {
    program: select({ label: "Program", options: PROGRAMS.map((p) => ({ value: p.id, label: p.label })), default: "web" }),
    profile: seg<ProfileId>("Profile", PROFILES.map((p) => [p.id, p.label] as [ProfileId, string]), "none"),
    late: toggle({ label: "Install the filter after startup (main loop only)", default: false }),
  });
  const program = PROGRAMS.find((p) => p.id === P.values.program)!;
  const phase = P.values.late ? "main" as const : "all" as const;
  const report = surfaceReport(P.values.profile, program, phase);
  const allowed = profileAllows(P.values.profile, program, phase);
  const needs = new Set(phase === "main" ? program.main : [...program.startup, ...program.main]);
  const [focus, setFocus] = useState<string | null>(null);
  const f = focus ? SYSCALLS.find((s) => s.name === focus) : null;
  const statusOf = (n: string) => needs.has(n) ? (allowed.has(n) ? "used" : "broken") : allowed.has(n) ? "open" : "removed";
  const STYLE: Record<string, React.CSSProperties> = {
    used: { background: "var(--c3)", borderColor: "var(--c3)" },
    broken: { background: "var(--c4)", borderColor: "var(--c4)" },
    open: { background: "var(--c1)", borderColor: "var(--c1)", opacity: 0.45 },
    removed: { background: "transparent", borderColor: "var(--border)" },
  };
  const WORD: Record<string, string> = { used: "the program needs it, and the profile allows it", broken: "the program needs it, but the profile stops it", open: "the program does not use it, but it stays open", removed: "the profile removes it" };
  return (
    <Demo title="How much of the kernel can this program reach?" controls={<>
      <Param spec={P.schema.program} value={P.values.program} onChange={(v) => P.set("program", v as string)} />
      <Param spec={P.schema.profile} value={P.values.profile} onChange={(v) => P.set("profile", v as ProfileId)} />
      <Param spec={P.schema.late} value={P.values.late} onChange={(v) => P.set("late", v as boolean)} />
    </>}>
      <Stats items={[
        { label: `calls allowed, of ${report.total} in this table`, value: report.allowed },
        { label: "removed", value: `${(report.removedFraction * 100).toFixed(1)}%` },
        { label: "needed by the program", value: report.needs },
        { label: "open but not used", value: report.unusedOpen },
        { label: "needed but stopped", value: report.broken.length },
      ]} />
      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {GROUPS.map((g) => (
          <div key={g}>
            <div className="muted" style={{ fontSize: 11 }}>{GROUP_LABEL[g]}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 2 }}>
              {SYSCALLS.filter((s) => s.group === g).map((s) => (
                <button key={s.name} aria-label={s.name} title={s.name} onClick={() => setFocus(s.name)} onMouseEnter={() => setFocus(s.name)}
                  style={{ width: 13, height: 13, padding: 0, borderRadius: 2, borderWidth: focus === s.name ? 2 : 1, borderStyle: "solid", cursor: "pointer", ...STYLE[statusOf(s.name)], outline: focus === s.name ? "1.5px solid var(--fg)" : "none" }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <Verdict tone={report.broken.length ? "bad" : "none"}>
        {f ? <><span style={mono}>{f.name}</span> (x86-64 number {f.nr}): {WORD[statusOf(f.name)]}.</> : "Hover or tap a square to see the call."}
        {report.broken.length > 0 && <> This profile breaks the program: {report.broken.slice(0, 5).join(", ")}{report.broken.length > 5 ? ", ..." : ""}.</>}
      </Verdict>
      <Note>Green: needed and allowed. Blue: open but not used. Red: needed but stopped. Empty: removed. This table has {report.total} common calls, and the real table has more. The "needed" lists are sample lists for typical builds.</Note>
    </Demo>
  );
}
