/**
 * Observability sims. Pure TypeScript. Other modules may import these.
 *
 * - ptrace:      `PtraceMachine`, a state machine with the rules of ptrace(2) (a request on a running tracee gives ESRCH),
 *                and `straceSteps`, the real tracer loop in plain and seccomp-filtered modes.
 * - breakpoint:  `X86Cpu` runs real x86-64 bytes. `Debugger` patches int3, steps over it and restores the bytes.
 *                `breakpointSteps` is the stepper, with mistakes that leave out a step.
 * - overhead:    `passNs`, `slowdown`: a labelled cost model of strace, seccomp-filtered strace and eBPF.
 * - patching:    `textPokeBp`, `naivePatch`, the bytes of a function entry, and the cost of ftrace per call.
 * - ringbuffer:  `RingBuffer`, `TraceBuffers`: pages, a reader page, overwrite and discard modes, `lossModel`, `runBurst`.
 * - sampling:    `simulateSampler`, `pSeen`, `pMissAll`, `lockstepShare`.
 * - bpfScalar:   tnums and bounds, with the arithmetic of the kernel verifier.
 * - bpfIsa:      the 8-byte encoding, `assemble`, `formatInsn`, `encodeInsns`, `decodeInsns`.
 * - bpfVm:       `BpfVm`, an interpreter with memory checks that do not depend on the verifier. `BpfMaps`.
 * - bpfVerifier: `verify`, control-flow checks and a walk of all paths with type and range tracking. `SUBSET_LIMITS`.
 * - bpfPresets:  `BPF_PRESETS`: safe programs, unsafe programs, and correct programs that are rejected.
 * - histogram:   `runInKernel`, `aggregateInUser`, and bytes across the kernel boundary.
 */
export * from "./ptrace";
export * from "./breakpoint";
export * from "./overhead";
export * from "./patching";
export * from "./ringbuffer";
export * from "./sampling";
export * from "./bpfScalar";
export * from "./bpfIsa";
export * from "./bpfVm";
export * from "./bpfVerifier";
export * from "./bpfPresets";
export * from "./histogram";
