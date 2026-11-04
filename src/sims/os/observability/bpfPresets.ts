/**
 * Programs for the verifier demo: safe ones, unsafe ones, and correct ones that the verifier still rejects.
 * `reason` is text that the rejection message must contain. The tests check each preset.
 */

export type PresetGroup = "safe" | "unsafe" | "correct";
export interface BpfPreset {
  id: string;
  label: string;
  group: PresetGroup;
  /** What the program does, and what to watch. */
  why: string;
  source: string;
  /** Text in the kernel-style message for a rejected program. */
  reason?: string;
  /** The instruction that the verifier rejects. */
  rejectPc?: number;
}

const MAP_LOOKUP = `  *(u32 *)(r10 - 4) = 0      ; key 0 on the stack
  r2 = r10
  r2 += -4                   ; r2 points to the key
  r1 = map[buf] ll
  call map_lookup_elem`;

export const BPF_PRESETS: BpfPreset[] = [
  // -------------------------------------------------------------- safe
  {
    id: "counter", label: "Count calls, with a null check", group: "safe",
    why: "After the call, r0 is map_value_or_null. The check turns it into map_value on one path and into 0 on the other.",
    source: `.type kprobe
.map counts array key=4 value=8 entries=1
  *(u32 *)(r10 - 4) = 0      ; key 0 on the stack
  r2 = r10
  r2 += -4
  r1 = map[counts] ll
  call map_lookup_elem
  if r0 == 0 goto out        ; the null check
  r1 = 1
  lock *(u64 *)(r0 + 0) += r1
out:
  r0 = 0
  exit`,
  },
  {
    id: "mask", label: "Index a value, with a mask", group: "safe",
    why: "The mask gives r6 the range [0, 63]. The value has 64 bytes, so each byte read is inside it.",
    source: `.type kprobe
.map buf array key=4 value=64 entries=1
  r6 = *(u64 *)(r1 + 112)    ; pt_regs.rdi: the first argument
${MAP_LOOKUP}
  if r0 == 0 goto out
  r6 &= 63                   ; r6 is now in [0, 63]
  r0 += r6
  r1 = *(u8 *)(r0 + 0)
out:
  r0 = 0
  exit`,
  },
  {
    id: "bounds", label: "Index a value, with a compare", group: "safe",
    why: "A conditional jump narrows the range. On the fall-through path r6 is at most 63, and the walk knows this.",
    source: `.type kprobe
.map buf array key=4 value=64 entries=1
  r6 = *(u64 *)(r1 + 112)
${MAP_LOOKUP}
  if r0 == 0 goto out
  if r6 > 63 goto out        ; here r6 is at most 63
  r0 += r6
  r1 = *(u8 *)(r0 + 0)
out:
  r0 = 0
  exit`,
  },
  {
    id: "loop", label: "Bounded loop with a constant", group: "safe",
    why: "The walk runs the loop 8 times, because r2 is a known constant each time. Each pass has a new state, so the loop makes progress.",
    source: `.type kprobe
  r2 = 0                     ; i
  r3 = r10
  r3 += -64                  ; an array of 8 u64 values
loop:
  *(u64 *)(r3 + 0) = r2
  r3 += 8
  r2 += 1
  if r2 < 8 goto loop
  r0 = *(u64 *)(r10 - 64)
  exit`,
  },
  {
    id: "rangeloop", label: "Bounded loop with a range", group: "safe",
    why: "Now the start value is not known. Watch the range of r2 narrow at each pass: [0, 7], then [1, 7], until only one value is left.",
    source: `.type kprobe
  r2 = *(u64 *)(r1 + 112)
  r2 &= 7                    ; start value in [0, 7]
loop:
  r2 += 1
  if r2 < 8 goto loop
  r0 = 0
  exit`,
  },
  {
    id: "xdp", label: "XDP: check data_end, then read", group: "safe",
    why: "The packet check gives r2 a safe range of 14 bytes. The EtherType at offset 12 is inside this range.",
    source: `.type xdp
  r2 = *(u32 *)(r1 + 0)      ; ctx->data
  r3 = *(u32 *)(r1 + 4)      ; ctx->data_end
  r4 = r2
  r4 += 14                   ; an Ethernet header has 14 bytes
  if r4 > r3 goto pass
  r5 = *(u16 *)(r2 + 12)     ; EtherType
  r5 = be16 r5
  if r5 != 0x800 goto pass
  r0 = 1                     ; XDP_DROP
  exit
pass:
  r0 = 2                     ; XDP_PASS
  exit`,
  },
  {
    id: "spill", label: "Save a pointer on the stack", group: "safe",
    why: "The stack remembers the type of a saved register. The check on r0 also marks the copy on the stack, so the reload is a real pointer.",
    source: `.type kprobe
.map buf array key=4 value=8 entries=1
${MAP_LOOKUP}
  *(u64 *)(r10 - 16) = r0    ; save the pointer
  if r0 == 0 goto out
  r1 = *(u64 *)(r10 - 16)    ; the reload is not null
  r0 = *(u64 *)(r1 + 0)
  exit
out:
  r0 = 0
  exit`,
  },

  // -------------------------------------------------------------- unsafe
  {
    id: "nonull", label: "No null check", group: "unsafe",
    why: "A hash lookup can fail. A read through a null pointer in the kernel would be an oops.",
    reason: "R0 invalid mem access 'map_value_or_null'", rejectPc: 6,
    source: `.type kprobe
.map buf hash key=4 value=8 entries=16
${MAP_LOOKUP}
  r0 = *(u64 *)(r0 + 0)
  exit`,
  },
  {
    id: "uninit", label: "Read a register with no value", group: "unsafe",
    why: "Only r1 and r10 have a value at the start. An old value in r2 could be a kernel address.",
    reason: "R2 !read_ok", rejectPc: 0,
    source: `.type kprobe
  r0 = r2
  exit`,
  },
  {
    id: "noret", label: "Exit with no return value", group: "unsafe",
    why: "The caller reads r0, so r0 must have a value on each path.",
    reason: "R0 !read_ok", rejectPc: 0,
    source: `.type kprobe
  exit`,
  },
  {
    id: "stackuninit", label: "Read stack that has no value", group: "unsafe",
    why: "The stack is not cleared. A read could copy old kernel data into a map.",
    reason: "invalid read from stack off -8+0 size 8", rejectPc: 0,
    source: `.type kprobe
  r0 = *(u64 *)(r10 - 8)
  exit`,
  },
  {
    id: "stackoob", label: "Write below the stack", group: "unsafe",
    why: "A program has only 512 bytes of stack. A lower address is other kernel memory.",
    reason: "invalid write to stack R10 off=-520 size=8", rejectPc: 0,
    source: `.type kprobe
  *(u64 *)(r10 - 520) = 0
  r0 = 0
  exit`,
  },
  {
    id: "derefscalar", label: "Use a number as a pointer", group: "unsafe",
    why: "The argument is only a number. To read kernel or user memory, a program must call a helper that handles faults.",
    reason: "R2 invalid mem access 'scalar'", rejectPc: 1,
    source: `.type kprobe
  r2 = *(u64 *)(r1 + 112)
  r0 = *(u64 *)(r2 + 0)
  exit`,
  },
  {
    id: "unbounded", label: "Index with no bound", group: "unsafe",
    why: "r6 can be any number, so the sum can point anywhere. The verifier stops at the addition.",
    reason: "math between map_value pointer and register with unbounded min value is not allowed", rejectPc: 8,
    source: `.type kprobe
.map buf array key=4 value=64 entries=1
  r6 = *(u64 *)(r1 + 112)
${MAP_LOOKUP}
  if r0 == 0 goto out
  r0 += r6
  r1 = *(u8 *)(r0 + 0)
out:
  r0 = 0
  exit`,
  },
  {
    id: "offbyone", label: "Off by one in the bound", group: "unsafe",
    why: "Index 64 reads one byte past a 64-byte value. The check must be r6 > 63.",
    reason: "invalid access to map value, value_size=64 off=64 size=1", rejectPc: 10,
    source: `.type kprobe
.map buf array key=4 value=64 entries=1
  r6 = *(u64 *)(r1 + 112)
${MAP_LOOKUP}
  if r0 == 0 goto out
  if r6 > 64 goto out        ; one too many
  r0 += r6
  r1 = *(u8 *)(r0 + 0)
out:
  r0 = 0
  exit`,
  },
  {
    id: "negative", label: "A signed check with a negative index", group: "unsafe",
    why: "A signed compare leaves negative values. r6 can be as low as -32768, which points before the value.",
    reason: "R0 min value is negative, either use unsigned index or do a if (index >=0) check.", rejectPc: 12,
    source: `.type kprobe
.map buf array key=4 value=64 entries=1
  r6 = *(u64 *)(r1 + 112)
${MAP_LOOKUP}
  if r0 == 0 goto out
  r6 <<= 48
  r6 s>>= 48                 ; sign-extend: r6 is now a signed 16-bit number
  if r6 s> 63 goto out
  r0 += r6
  r1 = *(u8 *)(r0 + 0)
out:
  r0 = 0
  exit`,
  },
  {
    id: "nopktcheck", label: "XDP: read with no data_end check", group: "unsafe",
    why: "The packet can be shorter than 13 bytes. A read past its end is outside the buffer.",
    reason: "invalid access to packet, off=12 size=1", rejectPc: 1,
    source: `.type xdp
  r2 = *(u32 *)(r1 + 0)
  r5 = *(u8 *)(r2 + 12)
  r0 = 2
  exit`,
  },
  {
    id: "shortpktcheck", label: "XDP: the check is too short", group: "unsafe",
    why: "The check proves 14 bytes, and the read wants byte 14, which is the 15th.",
    reason: "invalid access to packet, off=14 size=1", rejectPc: 5,
    source: `.type xdp
  r2 = *(u32 *)(r1 + 0)
  r3 = *(u32 *)(r1 + 4)
  r4 = r2
  r4 += 14
  if r4 > r3 goto pass
  r5 = *(u8 *)(r2 + 14)
pass:
  r0 = 2
  exit`,
  },
  {
    id: "spin", label: "A loop that never ends", group: "unsafe",
    why: "The state at the jump target is the same as before. The walk has made no progress, so a real run would not either.",
    reason: "infinite loop detected at insn 1", rejectPc: 1,
    source: `.type kprobe
  r0 = 0
loop:
  if r0 == 0 goto loop
  exit`,
  },
  {
    id: "spinrange", label: "An endless loop with an unknown value", group: "unsafe",
    why: "After the first pass, r1 is always odd, so the jump always happens. The second state repeats, so this is an endless loop.",
    reason: "infinite loop detected at insn 1", rejectPc: 1,
    source: `.type kprobe
  r1 = *(u64 *)(r1 + 112)
loop:
  r1 |= 1
  if r1 != 0 goto loop
  r0 = 0
  exit`,
  },
  {
    id: "unreachable", label: "Unreachable code", group: "unsafe",
    why: "Unreachable code is refused before the walk starts. It is often a sign of a bug, and it could hide bad bytes.",
    reason: "unreachable insn 2", rejectPc: 2,
    source: `.type kprobe
  r0 = 0
  exit
  r0 = 1
  exit`,
  },
  {
    id: "jumpout", label: "Jump out of the program", group: "unsafe",
    why: "The control-flow pass refuses a jump to an address outside the program.",
    reason: "jump out of range from insn 1 to 7", rejectPc: 1,
    source: `.type kprobe
  r0 = 0
  goto +5
  exit`,
  },
  {
    id: "falloff", label: "Run off the end", group: "unsafe",
    why: "The last instruction must not fall through into whatever comes next in memory.",
    reason: "last insn is not an exit or jmp", rejectPc: 0,
    source: `.type kprobe
  r0 = 0`,
  },
  {
    id: "leak", label: "Return a kernel address", group: "unsafe",
    why: "A pointer value would tell a user program where the kernel keeps its data. This breaks address randomization.",
    reason: "R0 leaks addr as return value", rejectPc: 1,
    source: `.type kprobe
  r0 = r10
  exit`,
  },
  {
    id: "maplap", label: "Store a kernel address in a map", group: "unsafe",
    why: "User space can read a map, so a pointer in a map is a leak.",
    reason: "R10 leaks addr into map", rejectPc: 7,
    source: `.type kprobe
.map buf array key=4 value=8 entries=1
${MAP_LOOKUP}
  if r0 == 0 goto out
  *(u64 *)(r0 + 0) = r10
out:
  r0 = 0
  exit`,
  },
  {
    id: "writefp", label: "Write to the frame pointer", group: "unsafe",
    why: "r10 is read-only. All stack checks depend on its value.",
    reason: "frame pointer is read only", rejectPc: 0,
    source: `.type kprobe
  r10 = 0
  r0 = 0
  exit`,
  },
  {
    id: "divzero", label: "Divide by a constant zero", group: "unsafe",
    why: "A constant zero is an obvious bug, so the load fails. A register that holds zero is allowed, and the result is then 0.",
    reason: "div by zero", rejectPc: 1,
    source: `.type kprobe
  r0 = 1
  r0 /= 0
  exit`,
  },

  // -------------------------------------------------------------- correct, but rejected
  {
    id: "selfsub", label: "x - x is always 0", group: "correct",
    why: "A real run always adds 0, so each read is safe. The verifier sees two values in [0, 7] and computes [-7, 7]. It does not know that they are equal.",
    reason: "R0 min value is negative, either use unsigned index or do a if (index >=0) check.", rejectPc: 12,
    source: `.type kprobe
.map buf array key=4 value=64 entries=1
  r6 = *(u64 *)(r1 + 112)
${MAP_LOOKUP}
  if r0 == 0 goto out
  r6 &= 7
  r7 = r6
  r7 -= r6                   ; always 0
  r0 += r7
  r1 = *(u8 *)(r0 + 0)
out:
  r0 = 0
  exit`,
  },
  {
    id: "modulo", label: "An index with %", group: "correct",
    why: "r6 % 64 is always in [0, 63]. This verifier has no range for %, so r6 becomes unknown. Use a mask here.",
    reason: "math between map_value pointer and register with unbounded min value is not allowed", rejectPc: 9,
    source: `.type kprobe
.map buf array key=4 value=64 entries=1
  r6 = *(u64 *)(r1 + 112)
${MAP_LOOKUP}
  if r0 == 0 goto out
  r6 %= 64                   ; always in [0, 63]
  r0 += r6
  r1 = *(u8 *)(r0 + 0)
out:
  r0 = 0
  exit`,
  },
  {
    id: "bigloop", label: "A long loop", group: "correct",
    why: "This loop ends after 2,000,000 passes. The walk does each pass, and it reaches its limit first. Linux has the same limit, at a higher number.",
    reason: "BPF program is too large. Processed 20001 insn", rejectPc: 2,
    source: `.type kprobe
  r2 = 0
loop:
  r2 += 1
  if r2 < 2000000 goto loop
  r0 = 0
  exit`,
  },
];

export const presetById = (id: string) => BPF_PRESETS.find((p) => p.id === id)!;

/**
 * The aggregate of the latency demo: log2 of a latency, then one atomic add in an array map.
 * This is the shape of a bcc or bpftrace hist(). The cascade has no loop, so a run takes few instructions.
 */
export const LOG2_HIST_SOURCE = `.type kprobe
.map hist array key=4 value=8 entries=64
  r6 = *(u64 *)(r1 + 112)    ; the latency in ns, as the first argument
  r7 = 0                     ; the bucket
  r2 = r6
  r2 >>= 32
  if r2 == 0 goto s16
  r7 += 32
  r6 >>= 32
s16:
  r2 = r6
  r2 >>= 16
  if r2 == 0 goto s8
  r7 += 16
  r6 >>= 16
s8:
  r2 = r6
  r2 >>= 8
  if r2 == 0 goto s4
  r7 += 8
  r6 >>= 8
s4:
  r2 = r6
  r2 >>= 4
  if r2 == 0 goto s2
  r7 += 4
  r6 >>= 4
s2:
  r2 = r6
  r2 >>= 2
  if r2 == 0 goto s1
  r7 += 2
  r6 >>= 2
s1:
  r2 = r6
  r2 >>= 1
  if r2 == 0 goto add
  r7 += 1
add:
  *(u32 *)(r10 - 4) = r7     ; the key
  r2 = r10
  r2 += -4
  r1 = map[hist] ll
  call map_lookup_elem
  if r0 == 0 goto out
  r1 = 1
  lock *(u64 *)(r0 + 0) += r1
out:
  r0 = 0
  exit`;
