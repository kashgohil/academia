/**
 * A cost model of one traced program: plain strace, strace with a seccomp filter, and eBPF.
 * The counts of stops and tracer calls per system call come from a real run of the ptrace loop (ptrace.ts).
 * All nanosecond figures are MODEL INPUTS. They have the right size for a modern x86-64 server, and they are not measurements.
 */
import { SWITCH_INPUTS, syscallNs } from "../processes";

/** MODEL INPUTS. */
export const TRACE_INPUTS = {
  /** A real system call with the usual mitigations, from the model in the system calls lesson. */
  syscallNs: syscallNs({ kpti: true, pcid: true, spectre: true, mds: false }),
  /** A switch between two address spaces, from the model in the context switch lesson. */
  switchNs: SWITCH_INPUTS.directNs + SWITCH_INPUTS.mmSwitchNs,
  /** strace decodes the arguments and formats one line. */
  formatNs: 2000,
  /** One run of the seccomp BPF filter on syscall entry. */
  filterNs: 30,
  /** A tracepoint and an eBPF program with a map update. It runs at entry and at exit. */
  ebpfRunNs: 60,
  /** Reserve and commit one event in a BPF ring buffer, for a call that the tool records. */
  ebpfEventNs: 80,
} as const;

/** Tracer system calls at one stop: waitpid, ptrace(PTRACE_SYSCALL), ptrace(PTRACE_GETREGS). Pinned against the real loop by a test. */
export const TRACER_CALLS_PER_STOP = 3;
export const STOPS_PER_CALL = 2;
/** Each stop moves the CPU to the tracer and back. */
export const SWITCHES_PER_STOP = 2;

export type TraceMode = "native" | "strace" | "seccomp" | "ebpf";

export const stopNs = () => SWITCHES_PER_STOP * TRACE_INPUTS.switchNs + TRACER_CALLS_PER_STOP * TRACE_INPUTS.syscallNs;

/** Time of one loop pass: `workNs` of user code and one system call. `tracedShare` is the share of calls that the tool records. */
export function passNs(mode: TraceMode, workNs: number, tracedShare: number): number {
  const c = TRACE_INPUTS;
  const base = workNs + c.syscallNs;
  const print = c.formatNs + c.syscallNs; // format, then write the line
  switch (mode) {
    case "native": return base;
    // Each call stops twice, even a call that strace will not print.
    case "strace": return base + STOPS_PER_CALL * stopNs() + tracedShare * print;
    // Only a recorded call stops. The filter runs on all calls.
    case "seccomp": return base + c.filterNs + tracedShare * (STOPS_PER_CALL * stopNs() + print);
    // The program runs in the kernel, with no switch. User space reads events in batches.
    case "ebpf": return base + STOPS_PER_CALL * c.ebpfRunNs + tracedShare * c.ebpfEventNs;
  }
}

export const slowdown = (mode: TraceMode, workNs: number, tracedShare: number) => passNs(mode, workNs, tracedShare) / passNs("native", workNs, tracedShare);

/** Calls per second under each tool. */
export const callsPerSecond = (mode: TraceMode, workNs: number, tracedShare: number) => 1e9 / passNs(mode, workNs, tracedShare);
