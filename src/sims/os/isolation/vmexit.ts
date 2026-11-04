/**
 * What a guest instruction costs under hardware virtualization.
 * Some instructions run directly in VMX non-root mode. Others cause a VM exit to the hypervisor. A few go on to user space.
 * All *_NS values and workload rates here are MODEL INPUTS: round figures of the right size, not measurements of one CPU.
 */
export const VM_COST = {
  /** Hardware VM exit plus VM entry: save and load state from the VMCS. About 1,500 cycles at 3 GHz. */
  exitEntryNs: 500,
  /** KVM's exit path and a small in-kernel handler. */
  kernelNs: 200,
  /** A longer handler: instruction decode, or a shadow page table update. */
  emulateNs: 1500,
  /** Leave the kernel, run the QEMU device model, and return through KVM_RUN. */
  userspaceNs: 6000,
  /** Lost cache and TLB state after an exit (indirect cost). */
  indirectNs: 300,
  /** HLT: the host schedules the vCPU out and wakes it later. */
  haltWakeNs: 5000,
} as const;

export const VM_MODEL_CPU_GHZ = 3;
export const exitEntryCycles = () => VM_COST.exitEntryNs * VM_MODEL_CPU_GHZ;

export interface VmFeatures { ept: boolean; tscOffset: boolean; apicv: boolean; ioeventfd: boolean }
export const DEFAULT_FEATURES: VmFeatures = { ept: true, tscOffset: true, apicv: true, ioeventfd: true };

export type Lane = "guest" | "kvm" | "qemu";
export interface Stage { lane: Lane; label: string; ns: number }
export interface GuestOp { id: string; asm: string; label: string; nativeNs: number; why: (f: VmFeatures) => string; path: (f: VmFeatures) => Stage[] }

const run = (label: string, ns: number): Stage => ({ lane: "guest", label, ns });
const exit = (reason: string, handler: string, ns: number): Stage[] => [
  { lane: "kvm", label: `VM exit: ${reason}`, ns: VM_COST.exitEntryNs / 2 },
  { lane: "kvm", label: handler, ns },
];
const entry = (): Stage[] => [
  { lane: "kvm", label: "VM entry (VMRESUME)", ns: VM_COST.exitEntryNs / 2 },
  { lane: "guest", label: "Caches and TLB refill", ns: VM_COST.indirectNs },
];

export const GUEST_OPS: GuestOp[] = [
  { id: "add", asm: "add rax, rbx", label: "Plain arithmetic", nativeNs: 0.3, why: () => "The CPU runs it directly in non-root mode. This is why VMs are fast.", path: () => [run("Runs directly", 0.3)] },
  { id: "syscall", asm: "syscall", label: "Guest system call", nativeNs: 60, why: () => "Ring 3 to ring 0 of the guest. No hypervisor is involved, because the guest has its own rings in non-root mode.", path: () => [run("Guest kernel entry and exit", 60)] },
  {
    id: "movcr3", asm: "mov cr3, rax", label: "Guest address space switch", nativeNs: 30,
    why: (f) => f.ept ? "With EPT, the guest owns its CR3, so the switch does not exit." : "With no EPT, the hypervisor keeps shadow page tables. It must see every CR3 write.",
    path: (f) => f.ept ? [run("Loads guest CR3", 30)] : [...exit("CR access", "Find or build the shadow table", VM_COST.emulateNs), ...entry()],
  },
  {
    id: "pf", asm: "; guest page fault", label: "Guest page fault", nativeNs: 500,
    why: (f) => f.ept ? "With EPT, the guest kernel handles its own faults, with no exit." : "With no EPT, the hypervisor must see faults to keep its shadow tables correct.",
    path: (f) => f.ept ? [run("Guest fault handler", 500)] : [...exit("Exception (#PF)", "Update the shadow table, or inject the fault", VM_COST.emulateNs), ...entry(), run("Guest fault handler", 500)],
  },
  {
    id: "ept", asm: "mov rax, [new_page]", label: "First touch of a guest page", nativeNs: 1,
    why: (f) => f.ept ? "The EPT has no entry for this guest physical page yet, so the host must allocate one." : "With no EPT, this appears as a shadow fault.",
    path: () => [...exit("EPT violation", "Host page fault, then fill the EPT entry", VM_COST.emulateNs), ...entry()],
  },
  { id: "cpuid", asm: "cpuid", label: "Identify the CPU", nativeNs: 30, why: () => "CPUID always exits on VT-x, so the hypervisor can choose what the guest sees. Do not call it in a hot path.", path: () => [...exit("CPUID", "Fill in the emulated values", VM_COST.kernelNs), ...entry()] },
  {
    id: "rdtsc", asm: "rdtsc", label: "Read the clock", nativeNs: 8,
    why: (f) => f.tscOffset ? "The CPU adds a stored offset, so no exit is needed." : "With RDTSC exiting on, the hypervisor emulates each read.",
    path: (f) => f.tscOffset ? [run("TSC + offset", 8)] : [...exit("RDTSC", "Compute the guest time", VM_COST.kernelNs), ...entry()],
  },
  {
    id: "ipi", asm: "; send IPI", label: "Interrupt another vCPU", nativeNs: 300,
    why: (f) => f.apicv ? "APIC virtualization delivers it in hardware when the target vCPU is running." : "With no APICv, each write to the APIC is trapped and emulated.",
    path: (f) => f.apicv ? [run("Virtual APIC write", 100)] : [...exit("APIC access", "Emulate the APIC, kick the target", VM_COST.emulateNs), ...entry()],
  },
  { id: "hlt", asm: "hlt", label: "Guest goes idle", nativeNs: 100, why: () => "A real HLT would stop the physical CPU. The host runs something else, and it wakes the vCPU on the next interrupt.", path: () => [...exit("HLT", "Schedule the vCPU out, then wake it", VM_COST.haltWakeNs), ...entry()] },
  { id: "vmcall", asm: "vmcall", label: "Hypercall", nativeNs: 0, why: () => "The guest asks the hypervisor for a service. Paravirtual interfaces use this, or a fast notify.", path: () => [...exit("VMCALL", "In-kernel hypercall", VM_COST.kernelNs), ...entry()] },
  {
    id: "kick", asm: "out dx, ax ; virtio kick", label: "Notify a virtio device", nativeNs: 300,
    why: (f) => f.ioeventfd ? "ioeventfd completes the exit in the kernel. It signals an eventfd, and vhost or a QEMU thread does the I/O elsewhere." : "With no ioeventfd, the exit goes all the way to QEMU in user space.",
    path: (f) => f.ioeventfd
      ? [...exit("I/O instruction", "Signal the ioeventfd", VM_COST.kernelNs), ...entry()]
      : [...exit("I/O instruction", "Return from KVM_RUN with KVM_EXIT_IO", VM_COST.kernelNs), { lane: "qemu", label: "QEMU handles the notify", ns: VM_COST.userspaceNs }, ...entry()],
  },
  {
    id: "mmio", asm: "mov [dev_reg], eax", label: "Register write, emulated device", nativeNs: 300,
    why: () => "Device registers have no EPT mapping. KVM decodes the instruction, and QEMU acts as the device.",
    path: () => [...exit("EPT misconfiguration", "Decode the instruction, KVM_EXIT_MMIO", VM_COST.emulateNs), { lane: "qemu", label: "QEMU device model", ns: VM_COST.userspaceNs }, ...entry()],
  },
];

export const opById = (id: string) => GUEST_OPS.find((o) => o.id === id)!;

export interface OpCost { exits: boolean; totalNs: number; nativeNs: number; ratio: number; stages: Stage[]; toUserspace: boolean }
export function opCost(op: GuestOp, f: VmFeatures = DEFAULT_FEATURES): OpCost {
  const stages = op.path(f);
  const totalNs = stages.reduce((a, s) => a + s.ns, 0);
  return { exits: stages.some((s) => s.lane === "kvm"), totalNs, nativeNs: op.nativeNs, ratio: op.nativeNs > 0 ? totalNs / op.nativeNs : Infinity, stages, toUserspace: stages.some((s) => s.lane === "qemu") };
}

/** Exits per second for each kind of exit in a workload. */
export type ExitMix = Partial<Record<string, number>>;

export interface Workload { id: string; label: string; ops: { op: string; perSecond: number }[] }

/** MODEL INPUTS. packets/s or I/O/s turned into exits with the device model below. */
export const WORKLOADS: Workload[] = [
  { id: "compute", label: "Number crunching", ops: [{ op: "hlt", perSecond: 0 }, { op: "ept", perSecond: 200 }, { op: "vmcall", perSecond: 250 }] },
  { id: "web", label: "Web server, 40k packets/s", ops: [{ op: "packet", perSecond: 40000 }, { op: "hlt", perSecond: 2000 }, { op: "ipi", perSecond: 4000 }] },
  { id: "db", label: "Database, 50k IOPS", ops: [{ op: "packet", perSecond: 50000 }, { op: "hlt", perSecond: 5000 }, { op: "ipi", perSecond: 8000 }] },
  { id: "cpuid", label: "A loop that calls CPUID", ops: [{ op: "cpuid", perSecond: 200000 }] },
];

export type DeviceModel = "emulated" | "virtio";
/** MODEL INPUT: an emulated device needs this many register writes per packet, each one a trip to QEMU. */
export const EMULATED_WRITES_PER_PACKET = 4;

/** Time lost per second of wall clock, as a fraction, and the exits per second. */
export function workloadOverhead(w: Workload, device: DeviceModel, batch: number, f: VmFeatures = DEFAULT_FEATURES) {
  let lostNs = 0, exits = 0;
  const parts: { label: string; exits: number; lostNs: number }[] = [];
  for (const { op, perSecond } of w.ops) {
    if (op === "packet") {
      const per = device === "emulated" ? opCost(opById("mmio"), f).totalNs : opCost(opById("kick"), f).totalNs;
      const count = device === "emulated" ? perSecond * EMULATED_WRITES_PER_PACKET : perSecond / batch;
      lostNs += count * per;
      exits += count;
      parts.push({ label: device === "emulated" ? "Emulated device writes" : "virtio kicks", exits: count, lostNs: count * per });
      continue;
    }
    const c = opCost(opById(op), f);
    const net = c.exits ? c.totalNs : 0;
    lostNs += perSecond * net;
    if (c.exits) exits += perSecond;
    parts.push({ label: opById(op).label, exits: c.exits ? perSecond : 0, lostNs: perSecond * net });
  }
  const lost = Math.min(1, lostNs / 1e9);
  return { exits, lost, slowdown: lost >= 1 ? Infinity : 1 / (1 - lost), parts };
}

/** Lost fraction for a rate of exits with one cost each. The line in the plot. */
export const lostFraction = (exitsPerSecond: number, costNs: number) => Math.min(1, (exitsPerSecond * costNs) / 1e9);

// ---------------- Popek and Goldberg ----------------

/** Classic x86 in 1999 terms: run the guest kernel in ring 3 and see what each instruction does there. */
export interface IsaInsn { name: string; sensitive: boolean; privileged: boolean; ring3: string; ring0: string }

export const X86_CLASSIC: IsaInsn[] = [
  { name: "add", sensitive: false, privileged: false, ring3: "Runs. Same result.", ring0: "Runs." },
  { name: "lgdt", sensitive: true, privileged: true, ring3: "Traps (#GP). The VMM can emulate it.", ring0: "Loads the GDT register." },
  { name: "mov cr3", sensitive: true, privileged: true, ring3: "Traps (#GP). The VMM can emulate it.", ring0: "Switches the page tables." },
  { name: "hlt", sensitive: true, privileged: true, ring3: "Traps (#GP). The VMM can emulate it.", ring0: "Stops the CPU until an interrupt." },
  { name: "popf", sensitive: true, privileged: false, ring3: "No trap. The CPU silently ignores the change to IF.", ring0: "Sets the interrupt flag." },
  { name: "pushf", sensitive: true, privileged: false, ring3: "No trap. It shows the real IF, not the guest's IF.", ring0: "Pushes the flags." },
  { name: "sgdt", sensitive: true, privileged: false, ring3: "No trap. It shows the VMM's GDT address, not the guest's.", ring0: "Stores the GDT register." },
  { name: "smsw", sensitive: true, privileged: false, ring3: "No trap. It shows the real low bits of CR0.", ring0: "Stores the low bits of CR0." },
];

/** The theorem: a trap-and-emulate VMM exists if every sensitive instruction is privileged. It returns the instructions that break the rule. */
export const popekGoldbergViolators = (isa: readonly IsaInsn[]) => isa.filter((i) => i.sensitive && !i.privileged);
export const virtualizable = (isa: readonly IsaInsn[]) => popekGoldbergViolators(isa).length === 0;

/** Under VT-x the guest kernel really is in ring 0 of non-root mode. Sensitive state is the guest's own, or the instruction exits. */
export const vtxBehaviour = (i: IsaInsn): string => {
  if (!i.sensitive) return "Runs directly.";
  if (i.name === "hlt") return "VM exit, if the hypervisor asks for it. The host can run another vCPU.";
  if (i.name === "mov cr3") return "Runs directly with EPT. It works on the guest's own CR3.";
  return "Runs directly, on the guest's own copy of this state in the VMCS.";
};

/** Figures from the Firecracker paper (Agache et al., NSDI 2020), quoted as published. */
export const FIRECRACKER_PAPER = { bootMs: 125, overheadMiB: 5 } as const;
