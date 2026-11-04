/** Every number that the Isolation lessons quote, computed by src/sims/os/isolation, and checked against the text. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CGROUP_DEFAULTS } from "@/sims/os/scheduling";
import * as I from "@/sims/os/isolation";

const text = (lesson: string) => readFileSync(new URL(`../../src/content/lessons/os/isolation/${lesson}.mdx`, import.meta.url), "utf8");
const has = (lesson: string, ...needles: string[]) => { const t = text(lesson); for (const n of needles) expect(t, n).toContain(n); };
const r1 = (x: number) => x.toFixed(1);

describe("users-permissions-and-capabilities", () => {
  const L = "users-permissions-and-capabilities";
  test("capability counts", () => {
    expect(I.CAP_COUNT).toBe(41);
    expect(I.capNumber("CHECKPOINT_RESTORE")).toBe(40);
    expect(I.capNumber("NET_BIND_SERVICE")).toBe(10);
    expect(I.capNumber("SYS_ADMIN")).toBe(21);
    expect(I.DOCKER_DEFAULT_CAPS.size).toBe(14);
    has(L, "Linux has 41 of them, numbered 0 to 40", "Docker keeps 14 capabilities");
  });
  test("the mode values in the text", () => {
    expect(I.modeString(0o1777, true)).toBe("drwxrwxrwt");
    expect(I.checkPermission({ uid: 1000, gid: 100, mode: 0o077 }, I.makeCred(1000, 1000, [100]), "r").allowed).toBe(false);
    expect(I.checkPermission({ uid: 1001, gid: 100, mode: 0o604 }, I.makeCred(1000, 1000, [100]), "r").allowed).toBe(false);
    has(L, "mode 0077", "`0604`", "`1777`");
  });
});

describe("namespaces", () => {
  const L = "namespaces";
  test("the type table", () => {
    expect(I.NAMESPACE_TYPES.length).toBe(8);
    for (const t of I.NAMESPACE_TYPES) has(L, `\`${t.flag}\``, `${t.since} |`);
    expect(I.NAMESPACE_TYPES.map((t) => t.value).reduce((a, b) => a | b, 0)).toBe(0x7e020080);
    has(L, "Linux has eight types");
  });
  test("limits and fixed values", () => {
    expect(I.MAX_PID_NS_LEVEL).toBe(32);
    expect(I.MAX_USER_NS_LEVEL).toBe(32);
    expect(I.PROC_PID_INIT_INO).toBe(4026531836);
    expect(I.UID_MAP_MAX_EXTENTS).toBe(340);
    expect(I.OVERFLOW_UID).toBe(65534);
    has(L, "a limit of 32 levels", "4026531836", "at most 340 lines", "65534");
  });
  test("the map example", () => {
    const m = I.parseMap("0 100000 65536");
    expect(I.toOutside(m, 0)).toBe(100000);
    expect(I.toOutside(m, 65535)).toBe(165535);
    expect(I.toOutside(m, 65536)).toBeNull();
    expect(I.displayedInside(m, 0)).toBe(65534);
    has(L, "maps inside UIDs 0 to 65535 to host UIDs 100000 to 165535", "0 100000 65536");
    const rootless = I.MAP_PRESETS.find((p) => p.id === "rootless")!.lines;
    expect(I.toOutside(rootless, 0)).toBe(1000);
    expect(I.toOutside(rootless, 1)).toBe(100000);
    has(L, "UID 1 maps to 100000");
  });
  test("the explorer's starting world: app is PID 4 and PID 1, with 3 visible from inside", () => {
    const w = new I.PidWorld();
    const root = [...w.procs.keys()][0]!;
    w.clone(root, "sshd");
    const shim = w.clone(root, "containerd-shim");
    const app = w.clone(shim, "app", { newPid: true });
    w.clone(app, "worker-a");
    w.clone(app, "worker-b");
    expect(w.procs.get(app)!.pids).toEqual([4, 1]);
    expect(app).toBe(4);
    expect(w.getppid(app)).toBe(0);
    expect(w.visibleFrom(w.procs.get(app)!.ns).length).toBe(3);
    has(L, "It has PID 4 at level 0 and PID 1 at level 1", "`ps` shows 3 processes");
    const three = w.clone(app, "n", { newPid: true });
    expect(w.procs.get(three)!.pids.length).toBe(3);
  });
});

describe("cgroups", () => {
  const L = "cgroups";
  const base = I.LATENCY_WORKLOAD;
  const p99 = (cpus: number | null, over: Partial<I.LatencySpec> = {}) => {
    const periodMs = over.periodMs ?? base.periodMs;
    return I.simulateLatency({ ...base, threads: 8, quotaMs: cpus === null ? null : cpus * periodMs, ...over }).p99;
  };
  test("cpu.max: 8 threads on a 1 CPU quota", () => {
    expect(I.parseCpuMax("100000 100000")).toEqual({ quotaUs: 100000, periodUs: 100000 });
    expect(I.cpusAllowed(I.parseCpuMax("100000 100000"))).toBe(1);
    expect(I.parseCpuMax("max 100000").quotaUs).toBeNull();
    const c = I.throttleStall(100, 100, 8);
    expect(c.burnMs).toBe(12.5);
    expect(c.stallMs).toBe(87.5);
    expect(I.throttleStall(100, 100, 1).stallMs).toBe(0);
    has(L, "12.5 ms", "87.5 ms", "`max 100000`");
  });
  test("slices of 5 ms make the run lengths uneven", () => {
    expect(I.DEFAULT_SLICE_MS).toBe(5);
    const s = I.simulateBandwidth({ quotaMs: 100, periodMs: 100, threads: 8, horizonMs: 300 });
    const runs = s.rows.map((r) => r[0]!.end - r[0]!.start).map((x) => Math.round(x));
    expect(new Set(runs)).toEqual(new Set([15, 10]));
    expect(s.nrPeriods).toBe(3);
    expect(s.nrThrottled).toBe(3);
    for (const u of s.perPeriod) expect(u).toBeCloseTo(100, 6);
    has(L, "Slices of 5 ms", "5 ms by default");
  });
  test("the p99 table", () => {
    expect(I.simulateLatency({ ...base, threads: 8, quotaMs: null }).meanCpus.toFixed(2)).toBe("0.41");
    expect(I.simulateLatency({ ...base, threads: 8, quotaMs: null }).p50).toBeCloseTo(2, 6);
    expect(base.rps).toBe(25);
    expect(base.requestCpuMs).toBe(16);
    expect(r1(p99(null))).toBe("3.8");
    expect(r1(p99(1.25))).toBe("3.8");
    expect(r1(p99(1))).toBe("4.7");
    expect(r1(p99(0.8))).toBe("33.0");
    expect(r1(p99(0.6))).toBe("111.8");
    expect(r1(p99(0.8) / p99(null))).toBe("8.6");
    has(L, "| no limit | 3.8 ms |", "| 1.25 CPUs | 3.8 ms |", "| 1.00 CPUs | 4.7 ms |", "| 0.80 CPUs | 33.0 ms |", "| 0.60 CPUs | 111.8 ms |", "about 8.6 times", "25 requests per second", "16 ms of CPU", "0.41 CPUs", "takes 2 ms");
  });
  test("one thread, burst and period", () => {
    const one = I.simulateLatency({ ...base, threads: 1, quotaMs: null }).p99;
    expect(r1(one)).toBe("55.4");
    expect(r1(I.simulateLatency({ ...base, threads: 1, quotaMs: 100 }).p99)).toBe("55.4");
    expect(r1(I.simulateLatency({ ...base, threads: 1, quotaMs: 200 }).p99)).toBe("55.4");
    has(L, "p99 of 55.4 ms");
    expect(r1(p99(0.8, { burstMs: 50 }))).toBe("3.8");
    has(L, "50 ms of burst brings p99 at 0.80 CPUs back to 3.8 ms");
    // A 10 ms period at 0.8 CPUs gives 8 ms of quota, less than one request of 16 ms.
    expect(0.8 * 10).toBeLessThan(base.requestCpuMs);
    expect(p99(0.8, { periodMs: 10 })).toBeGreaterThan(p99(0.8));
  });
  test("weights", () => {
    expect(I.CPU_WEIGHT).toEqual({ min: 1, def: 100, max: 10000 });
    expect(CGROUP_DEFAULTS.cpuWeight).toBe(I.CPU_WEIGHT.def);
    const rows = I.weightShares(I.EXAMPLE_TREE);
    const g = (n: string) => rows.find((r) => r.name === n)!;
    expect(r1(g("kubepods").global * 100)).toBe("80.0");
    expect(r1(g("api").local * 100)).toBe("75.0");
    expect(r1(g("api").global * 100)).toBe("60.0");
    expect(r1(g("batch").global * 100)).toBe("20.0");
    expect(r1(g("sshd").global * 100)).toBe("5.0");
    has(L, "`api` has 60.0%", "`batch` has 20.0%", "`sshd` has 5.0%", "runs from 1 to 10000", "default of 100");
    // Weight 1000 on sshd stays under the 10% of system.slice.
    const t: I.CgNode = JSON.parse(JSON.stringify(I.EXAMPLE_TREE));
    t.children![0]!.children![0]!.weight = 1000;
    const s = I.weightShares(t).find((r) => r.name === "sshd")!;
    expect(s.local).toBeGreaterThan(0.5);
    expect(s.global).toBeLessThan(0.1);
    // The Predict's wrong answer: 300 of 1,400.
    expect(Math.round((300 / 1400) * 100)).toBe(21);
    has(L, "About 21%");
  });
  test("memory", () => {
    expect(I.MAX_HIGH_DELAY_MS).toBe(2000);
    has(L, "One sleep lasts at most 2 s");
    const m = new I.Memcg({ maxMiB: 800, highMiB: 800 }, [{ name: "app", anon: 40 }]);
    m.readFile(700);
    expect(m.current).toBe(740);
    m.allocAnon("app", 200);
    expect(m.counters.oom).toBe(0);
    expect(m.file).toBe(560);
    has(L, "memory.max = 800 MiB", "700 MiB of page cache", "40 MiB of anonymous", "200 MiB");
  });
});

describe("seccomp-and-sandboxing", () => {
  const L = "seccomp-and-sandboxing";
  test("constants", () => {
    expect(I.SECCOMP_DATA_SIZE).toBe(64);
    expect(I.BPF_MAXINSNS).toBe(4096);
    expect(I.MAX_INSNS_PER_PATH).toBe(32768);
    expect(I.BPF_MEMWORDS).toBe(16);
    expect(I.AUDIT_ARCH.X86_64).toBe(0xc000003e);
    expect(I.OFF.nr).toBe(0);
    expect(I.OFF.arch).toBe(4);
    expect(I.OFF.ipLo).toBe(8);
    expect(I.OFF.argLo(0)).toBe(16);
    expect(I.X32_SYSCALL_BIT).toBe(2 ** 30);
    has(L, "64 bytes", "4,096 instructions", "32,768", "16 scratch words", "0xc000003e", "bit 30");
  });
  test("the action table", () => {
    for (const [k, v] of Object.entries(I.SECCOMP_RET)) {
      has(L, `\`${k}\` | \`0x${v.toString(16).padStart(8, "0")}\``);
      expect(I.actionOf(v)).toBe(k.toLowerCase());
    }
  });
  test("strict mode allows 4 calls", () => {
    expect(Object.keys(I.STRICT_MODE_NRS).length).toBe(4);
    for (const n of ["read", "write", "exit", "rt_sigreturn"]) expect(I.strictModeAllows(I.nrOf(n))).toBe(true);
    expect(I.strictModeAllows(I.nrOf("openat"))).toBe(false);
    has(L, "Only 4 calls stay");
  });
  test("the C example in the text has 7 instructions and behaves as stated", () => {
    const p: I.Insn[] = I.compile({ rules: [{ nr: I.nrOf("mount"), action: { kind: "errno", errno: I.ERRNO.EPERM } }], fallback: { kind: "allow" } });
    expect(p.length).toBe(9); // the same, plus the 2-instruction x32 check
    expect(I.run(p, { nr: I.nrOf("mount"), arch: I.AUDIT_ARCH.X86_64 }).action).toBe("errno");
    has(L, ".len = 7");
    // i386 number 0 and x86-64 number 0 are different calls: the arch check stops the confusion.
    expect(I.nrOf("read")).toBe(0);
    expect(I.run(p, { nr: 0, arch: 0x40000003 }).action).toBe("kill_process");
  });
  test("the surface numbers", () => {
    const web = I.PROGRAMS.find((p) => p.id === "web")!;
    const hello = I.PROGRAMS.find((p) => p.id === "hello")!;
    expect(I.SYSCALLS.length).toBe(187);
    expect(new Set(I.SYSCALLS.map((s) => s.nr)).size).toBe(187);
    expect(new Set(I.SYSCALLS.map((s) => s.name)).size).toBe(187);
    const docker = I.surfaceReport("docker", web);
    expect(docker.removed).toBe(38);
    expect(r1(docker.removedFraction * 100)).toBe("20.3");
    expect(docker.broken).toEqual([]);
    const allow = I.surfaceReport("allow", web);
    expect(allow.needs).toBe(38);
    expect(allow.removed).toBe(149);
    expect(r1(allow.removedFraction * 100)).toBe("79.7");
    expect(I.surfaceReport("strict", web).allowed).toBe(4);
    expect(I.surfaceReport("strict", web).broken.length).toBeGreaterThan(30);
    expect(I.surfaceReport("allow", web, "main").allowed).toBe(25);
    expect(I.surfaceReport("allow", hello, "main").allowed).toBe(3);
    expect(I.DOCKER_DOC_BLOCKED).toBe(44);
    has(L, "38 of the 187", "20.3%", "149 calls", "79.7%", "needs 25 calls, not 38", "needs only 3", "around 44 calls of more than 300", "so it shows 38");
    for (const s of ["mount", "bpf", "kexec_load"]) expect(I.profileAllows("docker", web).has(s)).toBe(false);
  });
});

describe("containers", () => {
  const L = "containers";
  test("the assemble demo", () => {
    expect(I.PRIMITIVES.length).toBe(8);
    const all = I.containerView(new Set(I.ALL_PRIMITIVES));
    const none = I.containerView(new Set());
    expect(all.pid).toBe(1);
    expect(all.psCount).toBe(1);
    expect(none.psCount).toBe(6);
    expect(none.pid).toBe(6);
    expect(all.capCount).toBe(14);
    expect(none.capCount).toBe(41);
    expect(all.syscalls).toBe(149);
    expect(none.syscalls).toBe(187);
    expect(all.uidOnHost).toBe(100000);
    expect(none.uidOnHost).toBe(0);
    expect(all.exposed.length).toBe(0);
    expect(none.exposed.length).toBe(8);
    expect(all.kernel).toBe(none.kernel);
    has(L, "**Apply** eight times", "from 14 to 41", "All 187 calls", "not 149");
    // PID alone: getpid is 1, ps still reads the host's /proc. With the mount namespace: 1.
    const pidOnly = I.containerView(new Set(["pid"]));
    expect(pidOnly.pid).toBe(1);
    expect(pidOnly.psCount).toBe(6);
    expect(I.containerView(new Set(["pid", "mnt"])).psCount).toBe(1);
    has(L, "`getpid()` is 1, but `ps` still lists 6 processes", "`ps` lists 1");
  });
  test("copy-up of a 1 GiB file for 1 byte", () => {
    const o = new I.Overlay(I.sampleImage());
    expect(o.write("/data/seed.db", 1, "x")).toBe(1024 ** 3);
    expect(o.writtenBytes).toBe(1);
    expect(o.write("/data/seed.db", 1, "y")).toBe(0);
    has(L, "1 GiB copied for 1 byte written", "1 byte of a 1 GiB file");
  });
});

describe("virtual-machines-and-hypervisors", () => {
  const L = "virtual-machines-and-hypervisors";
  const nf = { ...I.DEFAULT_FEATURES, ept: false };
  const us = (id: string, f = I.DEFAULT_FEATURES) => I.opCost(I.opById(id), f).totalNs / 1000;
  test("the theorem and classic x86", () => {
    expect(I.virtualizable(I.X86_CLASSIC)).toBe(false);
    expect(I.popekGoldbergViolators(I.X86_CLASSIC).map((i) => i.name)).toEqual(["popf", "pushf", "sgdt", "smsw"]);
    has(L, "`popf`, `pushf`, `sgdt` and `smsw`", "1974");
  });
  test("exit costs in the model", () => {
    expect(I.exitEntryCycles()).toBe(1500);
    has(L, "about 1,500 cycles");
    expect(us("cpuid")).toBe(1);
    expect(Math.round(I.opCost(I.opById("cpuid")).ratio)).toBe(33);
    expect(I.opCost(I.opById("cpuid")).nativeNs).toBe(30);
    has(L, "CPUID takes 1 µs against 30 ns", "about 33 times");
    expect(us("movcr3", nf)).toBe(2.3);
    has(L, "A CR3 write now costs 2.3 µs");
    expect(us("kick")).toBe(1);
    expect(us("kick", { ...I.DEFAULT_FEATURES, ioeventfd: false })).toBe(7);
    has(L, "from 1 µs to 7 µs");
    expect(us("mmio")).toBe(8.3);
    has(L, "At 8.3 µs");
    expect(Math.max(...I.GUEST_OPS.map((o) => I.opCost(o).totalNs))).toBe(8300);
  });
  test("which operations exit with EPT", () => {
    const exits = (id: string) => I.opCost(I.opById(id)).exits;
    expect(exits("syscall")).toBe(false);
    expect(exits("pf")).toBe(false);
    expect(exits("movcr3")).toBe(false);
    expect(exits("add")).toBe(false);
    expect(exits("cpuid")).toBe(true);
    expect(I.opCost(I.opById("movcr3"), nf).exits).toBe(true);
    expect(I.opCost(I.opById("pf"), nf).exits).toBe(true);
  });
  test("workloads", () => {
    expect(I.lostFraction(10000, 1000)).toBeCloseTo(0.01, 12);
    has(L, "10,000 VM exits per second", "which is 1%");
    const w = (id: string) => I.WORKLOADS.find((x) => x.id === id)!;
    const web = I.workloadOverhead(w("web"), "virtio", 16);
    expect(web.exits).toBe(4500);
    expect(r1(web.lost * 100)).toBe("1.4");
    has(L, "4,500 exits per second", "loses 1.4%");
    expect(I.workloadOverhead(w("web"), "emulated", 16).lost).toBe(1);
    expect(I.EMULATED_WRITES_PER_PACKET).toBe(4);
    has(L, "4 register writes", "reaches 100%");
    expect(I.workloadOverhead(w("cpuid"), "virtio", 16).lost).toBeCloseTo(0.2, 9);
    has(L, "It loses 20%");
    expect(I.workloadOverhead(w("web"), "virtio", 1).exits).toBeGreaterThan(web.exits);
  });
  test("the nested walk, by the real walkers", () => {
    const reads = (s: I.NestedSpec) => I.realNestedWalk(s).reads.length;
    expect(reads({})).toBe(24);
    expect(I.nestedWalkReads(4, 4)).toBe(24);
    expect(reads({ guestLevels: 5, hostLevels: 5 })).toBe(35);
    expect(reads({ hostPage: "2m" })).toBe(19);
    expect(reads({ hostPage: "2m", guestPage: "2m" })).toBe(15);
    expect(reads({ hostPage: "1g", guestPage: "1g" })).toBe(8);
    expect(I.nativeReads(4)).toBe(4);
    expect(24 / I.nativeReads(4)).toBe(6);
    const w = I.realNestedWalk();
    expect(w.reads.filter((r) => r.kind === "guest").length).toBe(4);
    expect(w.reads.filter((r) => r.kind === "host").length).toBe(20);
    expect(w.reads.filter((r) => r.col === 0).length).toBe(5);
    expect(w.reads.filter((r) => r.col === 4).length).toBe(4);
    has(L, "1 to 24", "The walk needs 35 reads", "falls to 19", "falls to 15", "falls to 8", "ratio is 6 times", "(4 + 1)(4 + 1) - 1 = 24", "which gives 20");
  });
  test("Firecracker figures, as published", () => {
    expect(I.FIRECRACKER_PAPER).toEqual({ bootMs: 125, overheadMiB: 5 });
    has(L, "about 125 ms", "less than 5 MiB");
  });
});
