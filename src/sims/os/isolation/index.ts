/**
 * Reference models for the "Isolation" module. Pure TypeScript, no React.
 * These explain defensive mechanisms. They do not contain exploit steps.
 *
 * - perm: `checkPermission` (generic_permission: one class of bits, then capability overrides), `modeString`,
 *         `mayDelete` (sticky), `newFileGid` (setgid), `execCred`, `setuid`, `seteuid`.
 * - caps: `CAP_NAMES`, `execveCaps` (cap_bprm_creds_from_file for all five sets), `ambientRaise`, `capsInvariant`, `DOCKER_DEFAULT_CAPS`.
 * - pidns: `PidWorld` (one PID per namespace level, clone, unshare, resolve, visibleFrom, exit with the PID 1 rule), `NAMESPACE_TYPES`, `propagates`.
 * - uidmap: `validateMap`, `toOutside`, `toInside`, `displayedInside`, nested translation, `mayWriteMap`.
 * - netns: `NetSim`: routes, ARP, a learning bridge, veth pairs and NAT, with one Hop per action.
 * - cgroup: `weightShares`, `levelSums`, `parseCpuMax`, `throttleStall`.
 * - cpumax: `simulateBandwidth` (tick model with slices, cpu.stat), `simulateLatency` and `latencySweep` (request queue).
 * - memcg: `Memcg` (charge path with memory.high, memory.max, memory.low, swap and the cgroup OOM), `highPenaltyMs`.
 * - bpf: classic BPF for seccomp: `validate`, `run` with a trace, `disasm`, `compile`, `evalSpec`, `runStack`.
 * - surface: `SYSCALLS` (a table of common x86-64 calls), `PROGRAMS`, `surfaceReport`.
 * - overlay: `Overlay` (read, write with copy-up, whiteouts, opaque directories), `sampleImage`.
 * - assemble: `PRIMITIVES`, `containerView`, `ESCAPE_CLASSES`.
 * - vmexit: `GUEST_OPS`, `opCost`, `workloadOverhead`, `popekGoldbergViolators`.
 * - nestedwalk: `realNestedWalk` with two real page tables from ../vm.
 *
 * Every typical-hardware figure is a named MODEL INPUT in the file that uses it (VM_COST, WORKLOADS, SYSCALLS).
 */
export * from "./perm";
export * from "./caps";
export * from "./pidns";
export * from "./uidmap";
export * from "./netns";
export * from "./cgroup";
export * from "./cpumax";
export * from "./memcg";
export * from "./bpf";
export * from "./surface";
export * from "./overlay";
export * from "./assemble";
export * from "./vmexit";
export * from "./nestedwalk";
