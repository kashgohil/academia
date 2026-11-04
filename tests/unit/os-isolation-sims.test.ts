/** Properties of the isolation models: real checks against tables of hand-worked cases, and round trips on random input. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "../../src/sims/rng";
import { cgroupShares, type CgroupNode } from "../../src/sims/os/scheduling";
import {
  ALL_CAPS, AUDIT_ARCH, BPF, GUEST_OPS, MAX_PID_NS_LEVEL, Memcg, NO_CAPS, NetSim, Overlay, PidWorld, SECCOMP_RET, UID_MAP_MAX_EXTENTS, X32_SYSCALL_BIT,
  actionOf, ambientRaise, caps, capsInvariant, checkPermission, compile, displayedInside, evalSpec, execCred, execveCaps, fromHostNested, levelSums, makeCred, makeLayer, mayDelete,
  mayWriteMap, modeString, newFileGid, nestedWalkReads, opCost, parseCpuMax, parseMap, permClass, plainProc, propagates, realNestedWalk, run, runStack, sampleImage, setuid, seteuid, simulateBandwidth, simulateLatency, strongest,
  throttleStall, toHostNested, toInside, toOutside, validate, validateMap, weightShares, type Cap, type CapSet, type CgNode, type Insn, type MapLine, type NestedPageSize, type Rule, type RuleAction, type SeccompData, type Want,
} from "../../src/sims/os/isolation";

const ins = (code: number, k = 0, jt = 0, jf = 0): Insn => ({ code, jt, jf, k });
const X86 = AUDIT_ARCH.X86_64;
const data = (nr: number, args: bigint[] = [], arch: number = X86): SeccompData => ({ nr, arch, args });

describe("permission check", () => {
  test("exactly one class applies, and it is the first that matches", () => {
    const rng = mulberry32(1);
    const ids = [0, 1000, 1001];
    const groups = [0, 100, 200];
    for (let i = 0; i < 3000; i++) {
      const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)]!;
      const inode = { uid: pick(ids), gid: pick(groups), mode: Math.floor(rng() * 0o1000) };
      const cred = makeCred(pick(ids), pick(groups), rng() < 0.5 ? [pick(groups)] : []);
      const want = pick(["r", "w", "x"] as Want[]);
      const r = checkPermission(inode, cred, want);
      const expected = cred.fsuid === inode.uid ? "owner" : cred.fsgid === inode.gid || cred.groups.includes(inode.gid) ? "group" : "other";
      expect(r.cls).toBe(expected);
      const shift = { owner: 6, group: 3, other: 0 }[expected];
      const bit = { r: 4, w: 2, x: 1 }[want];
      expect(r.allowed).toBe(((inode.mode >> shift) & bit) !== 0);
    }
  });
  test.each([
    // uid, gid, mode, fsuid, fsgid, groups, want, allowed, class
    [1000, 100, 0o077, 1000, 1000, [100], "r", false, "owner"],
    [1001, 100, 0o604, 1000, 1000, [100], "r", false, "group"],
    [1001, 100, 0o604, 1000, 1000, [], "r", true, "other"],
    [1001, 100, 0o640, 1000, 1000, [100], "r", true, "group"],
    [1000, 100, 0o400, 1000, 1000, [], "w", false, "owner"],
  ] as const)("case uid=%i gid=%i mode=%o", (uid, gid, mode, fsuid, fsgid, groups, want, allowed, cls) => {
    const r = checkPermission({ uid, gid, mode }, makeCred(fsuid, fsgid, groups), want);
    expect(r.allowed).toBe(allowed);
    expect(r.cls).toBe(cls);
  });
  test("capabilities override as in generic_permission", () => {
    const root = makeCred(0, 0, [], ["CAP_DAC_OVERRIDE", "CAP_DAC_READ_SEARCH"]);
    const f = { uid: 1001, gid: 100, mode: 0o000 };
    expect(checkPermission(f, root, "r").override).toBe("CAP_DAC_READ_SEARCH");
    expect(checkPermission(f, root, "w").override).toBe("CAP_DAC_OVERRIDE");
    // No x bit anywhere: even root cannot execute it.
    expect(checkPermission(f, root, "x").allowed).toBe(false);
    expect(checkPermission({ ...f, mode: 0o001 }, root, "x").allowed).toBe(true);
    // A directory can always be searched.
    expect(checkPermission({ ...f, isDir: true }, root, "x").allowed).toBe(true);
    // UID 0 with no capabilities gets no override.
    expect(checkPermission(f, makeCred(0, 0), "r").allowed).toBe(false);
  });
  test("mode strings", () => {
    expect(modeString(0o4755)).toBe("-rwsr-xr-x");
    expect(modeString(0o4644)).toBe("-rwSr--r--");
    expect(modeString(0o1777, true)).toBe("drwxrwxrwt");
    expect(modeString(0o2775, true)).toBe("drwxrwsr-x");
    expect(modeString(0o077)).toBe("----rwxrwx");
  });
  test("sticky bit and setgid directory", () => {
    const tmp = { uid: 0, gid: 0, mode: 0o1777, isDir: true };
    const bobs = { uid: 1001, gid: 1001, mode: 0o666 };
    expect(mayDelete(tmp, bobs, makeCred(1000, 1000))).toBe(false);
    expect(mayDelete(tmp, bobs, makeCred(1001, 1001))).toBe(true);
    expect(mayDelete({ ...tmp, mode: 0o777 }, bobs, makeCred(1000, 1000))).toBe(true);
    expect(newFileGid({ uid: 0, gid: 100, mode: 0o2775 }, makeCred(1000, 1000))).toBe(100);
    expect(newFileGid({ uid: 0, gid: 100, mode: 0o775 }, makeCred(1000, 1000))).toBe(1000);
  });
  test("setuid rules: drop for a moment, then for good", () => {
    let c = execCred(makeCred(1000, 1000), { uid: 0, gid: 0, mode: 0o4755 });
    expect([c.ruid, c.euid, c.suid]).toEqual([1000, 0, 0]);
    expect(checkPermission({ uid: 0, gid: 42, mode: 0o640 }, c, "r").allowed).toBe(true);
    c = seteuid(c, 1000) as typeof c;
    expect([c.ruid, c.euid, c.suid]).toEqual([1000, 1000, 0]);
    expect(checkPermission({ uid: 0, gid: 42, mode: 0o640 }, c, "r").allowed).toBe(false);
    c = seteuid(c, 0) as typeof c;
    expect(c.euid).toBe(0);
    c = setuid(c, 1000) as typeof c;
    expect([c.ruid, c.euid, c.suid]).toEqual([1000, 1000, 1000]);
    expect(seteuid(c, 0)).toBe("EPERM");
    expect(permClass({ uid: 1000, gid: 0, mode: 0 }, c)).toBe("owner");
  });
});

describe("capability execve rules", () => {
  const NB = caps("NET_BIND_SERVICE");
  const SA = caps("SYS_ADMIN");
  test("the capability does not survive a plain execve", () => {
    const p = plainProc(1000, { permitted: NB, effective: NB });
    const n = execveCaps(p, {}).next;
    expect(n.permitted.size + n.effective.size).toBe(0);
  });
  test("the ambient set survives a plain execve, and a file with capabilities clears it", () => {
    const p = plainProc(1000, { permitted: NB, effective: NB, inheritable: NB, ambient: NB });
    const n = execveCaps(p, {}).next;
    expect([...n.ambient]).toEqual(["NET_BIND_SERVICE"]);
    expect([...n.effective]).toEqual(["NET_BIND_SERVICE"]);
    const f = execveCaps(p, { hasCaps: true, fP: SA, fE: true });
    expect(f.next.ambient.size).toBe(0);
    expect(f.privilegedFile).toBe(true);
  });
  test("setcap +ep gives the capability, limited by the bounding set", () => {
    expect([...execveCaps(plainProc(1000), { hasCaps: true, fP: NB, fE: true }).next.effective]).toEqual(["NET_BIND_SERVICE"]);
    expect(execveCaps(plainProc(1000, { bounding: NO_CAPS }), { hasCaps: true, fP: NB, fE: true }).next.permitted.size).toBe(0);
    // Without the effective bit, the capability is permitted but not effective.
    const n = execveCaps(plainProc(1000), { hasCaps: true, fP: NB, fE: false }).next;
    expect(n.permitted.has("NET_BIND_SERVICE")).toBe(true);
    expect(n.effective.size).toBe(0);
  });
  test("the file inheritable set meets the process inheritable set", () => {
    expect(execveCaps(plainProc(1000, { inheritable: NB }), { hasCaps: true, fI: NB }).next.permitted.has("NET_BIND_SERVICE")).toBe(true);
    expect(execveCaps(plainProc(1000), { hasCaps: true, fI: NB }).next.permitted.size).toBe(0);
  });
  test("root rule: all of the bounding set, and only a root effective UID sets effective", () => {
    const r = execveCaps(plainProc(0), {});
    expect(r.rootRule).toBe(true);
    expect(r.next.permitted.size).toBe(ALL_CAPS.size);
    expect(r.next.effective.size).toBe(ALL_CAPS.size);
    const cut = caps("SETUID");
    expect([...execveCaps(plainProc(0, { bounding: cut }), {}).next.effective]).toEqual(["SETUID"]);
    // Real UID 0 with another effective UID: permitted, not effective.
    const realOnly = execveCaps({ ...plainProc(0), euid: 1000 }, {}).next;
    expect(realOnly.permitted.size).toBe(ALL_CAPS.size);
    expect(realOnly.effective.size).toBe(0);
  });
  test("setuid root gives root rights; with file capabilities a non-root caller gets only those", () => {
    const n = execveCaps(plainProc(1000), { setuid: true, ownerUid: 0 }).next;
    expect(n.euid).toBe(0);
    expect(n.effective.size).toBe(ALL_CAPS.size);
    const m = execveCaps(plainProc(1000), { setuid: true, ownerUid: 0, hasCaps: true, fP: NB, fE: true }).next;
    expect([...m.permitted]).toEqual(["NET_BIND_SERVICE"]);
  });
  test("no_new_privs ignores setuid and limits file capabilities", () => {
    const a = execveCaps(plainProc(1000, { noNewPrivs: true }), { setuid: true, ownerUid: 0 }).next;
    expect(a.euid).toBe(1000);
    expect(a.permitted.size).toBe(0);
    const b = execveCaps(plainProc(1000, { noNewPrivs: true }), { hasCaps: true, fP: NB, fE: true }).next;
    expect(b.permitted.size).toBe(0);
  });
  test("ambient raise needs permitted and inheritable", () => {
    expect(ambientRaise(plainProc(1000, { permitted: NB }), "NET_BIND_SERVICE")).toBe("EPERM");
    expect(ambientRaise(plainProc(1000, { inheritable: NB }), "NET_BIND_SERVICE")).toBe("EPERM");
    const ok = ambientRaise(plainProc(1000, { permitted: NB, inheritable: NB }), "NET_BIND_SERVICE");
    expect(ok).not.toBe("EPERM");
  });
  test("invariants hold after any execve", () => {
    const rng = mulberry32(5);
    const pool: Cap[] = ["NET_BIND_SERVICE", "SYS_ADMIN", "SETUID", "CHOWN"];
    const rand = (): CapSet => new Set(pool.filter(() => rng() < 0.5));
    for (let i = 0; i < 3000; i++) {
      const permitted = rand();
      const inheritable = rand();
      const ambient: CapSet = new Set([...rand()].filter((c) => permitted.has(c) && inheritable.has(c)));
      const effective: CapSet = new Set([...rand()].filter((c) => permitted.has(c)));
      const uid = rng() < 0.3 ? 0 : 1000;
      const p = { ruid: uid, euid: uid, permitted, effective, inheritable, bounding: rand(), ambient, noNewPrivs: rng() < 0.3 };
      expect(capsInvariant(p)).toBe(true);
      const r = execveCaps(p, { setuid: rng() < 0.3, ownerUid: 0, hasCaps: rng() < 0.5, fP: rand(), fI: rand(), fE: rng() < 0.5 });
      expect([...r.next.ambient].every((c) => r.next.permitted.has(c))).toBe(true);
      expect([...r.next.effective].every((c) => r.next.permitted.has(c))).toBe(true);
      expect(r.next.bounding).toBe(p.bounding);
      expect(r.next.inheritable).toBe(p.inheritable);
      if (p.noNewPrivs) expect([...r.next.permitted].every((c) => p.permitted.has(c) || p.ambient.has(c))).toBe(true);
    }
  });
});

describe("PID namespaces", () => {
  function randomWorld(seed: number) {
    const rng = mulberry32(seed);
    const w = new PidWorld();
    const ids = [...w.procs.keys()];
    for (let i = 0; i < 40; i++) {
      const parent = ids[Math.floor(rng() * ids.length)]!;
      ids.push(w.clone(parent, `p${i}`, { newPid: rng() < 0.2 }));
    }
    return w;
  }
  test("PID translation round-trips in every namespace that can see the process", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const w = randomWorld(seed);
      for (const p of w.procs.values()) {
        for (const ns of w.spaces.keys()) {
          const pid = w.pidIn(p.id, ns);
          const ancestor = w.chain(p.ns).some((s) => s.id === ns);
          expect(pid !== null).toBe(ancestor);
          if (pid !== null) expect(w.resolve(ns, pid)).toBe(p.id);
        }
        expect(p.pids.length).toBe(w.spaces.get(p.ns)!.level + 1);
      }
    }
  });
  test("PIDs are unique within a namespace, and the root sees every process", () => {
    const w = randomWorld(3);
    for (const ns of w.spaces.keys()) {
      const v = w.visibleFrom(ns).map((p) => w.pidIn(p.id, ns));
      expect(new Set(v).size).toBe(v.length);
    }
    expect(w.visibleFrom(w.rootNs).length).toBe(w.procs.size);
  });
  test("a new namespace starts at PID 1, and getppid across the boundary is 0", () => {
    const w = new PidWorld();
    const root = [...w.procs.keys()][0]!;
    const a = w.clone(root, "a");
    const init = w.clone(a, "init", { newPid: true });
    const p = w.procs.get(init)!;
    expect(p.pids).toEqual([3, 1]);
    expect(w.getppid(init)).toBe(0);
    const kid = w.clone(init, "kid");
    expect(w.procs.get(kid)!.pids).toEqual([4, 2]);
    expect(w.getppid(kid)).toBe(1);
  });
  test("unshare moves only the children", () => {
    const w = new PidWorld();
    const root = [...w.procs.keys()][0]!;
    const a = w.clone(root, "a");
    const before = w.procs.get(a)!.ns;
    w.unsharePid(a);
    expect(w.procs.get(a)!.ns).toBe(before);
    const c = w.clone(a, "c");
    expect(w.procs.get(c)!.pids[1]).toBe(1);
    expect(() => w.clone(a, "d")).not.toThrow();
  });
  test("PID 1 death kills the namespace and the namespaces below it; fork then fails", () => {
    const w = new PidWorld();
    const root = [...w.procs.keys()][0]!;
    const init = w.clone(root, "init", { newPid: true });
    const kid = w.clone(init, "kid");
    const inner = w.clone(kid, "inner", { newPid: true });
    const died = w.exit(init);
    expect(died.sort()).toEqual([init, kid, inner].sort());
    expect(w.visibleFrom(w.rootNs).map((p) => p.id)).toEqual([root]);
  });
  test("an orphan moves to PID 1 of its namespace", () => {
    const w = new PidWorld();
    const root = [...w.procs.keys()][0]!;
    const init = w.clone(root, "init", { newPid: true });
    const mid = w.clone(init, "mid");
    const leaf = w.clone(mid, "leaf");
    w.exit(mid);
    expect(w.procs.get(leaf)!.parent).toBe(init);
    expect(w.getppid(leaf)).toBe(1);
  });
  test("PID 1 ignores signals with no handler from inside; SIGKILL from an ancestor arrives", () => {
    const w = new PidWorld();
    const root = [...w.procs.keys()][0]!;
    const init = w.clone(root, "init", { newPid: true });
    const kid = w.clone(init, "kid");
    expect(w.signalDelivered(kid, init, "SIGKILL", false)).toBe(false);
    expect(w.signalDelivered(kid, init, "SIGTERM", false)).toBe(false);
    expect(w.signalDelivered(kid, init, "SIGTERM", true)).toBe(true);
    expect(w.signalDelivered(root, init, "SIGKILL", false)).toBe(true);
    expect(w.signalDelivered(root, kid, "SIGTERM", false)).toBe(true);
    // A process inside cannot name one outside.
    expect(w.signalDelivered(kid, root, "SIGTERM", true)).toBe(false);
  });
  test("the nesting limit", () => {
    const w = new PidWorld();
    let cur = [...w.procs.keys()][0]!;
    for (let i = 1; i < MAX_PID_NS_LEVEL; i++) cur = w.clone(cur, `n${i}`, { newPid: true });
    expect(w.spaces.get(w.procs.get(cur)!.ns)!.level).toBe(MAX_PID_NS_LEVEL - 1);
    expect(() => w.clone(cur, "too-deep", { newPid: true })).toThrow("ENOSPC");
  });
  test("mount propagation table", () => {
    expect(propagates("shared")).toEqual({ originToCopy: true, copyToOrigin: true, canBindMount: true });
    expect(propagates("slave")).toEqual({ originToCopy: true, copyToOrigin: false, canBindMount: true });
    expect(propagates("private")).toEqual({ originToCopy: false, copyToOrigin: false, canBindMount: true });
    expect(propagates("unbindable").canBindMount).toBe(false);
  });
});

describe("uid_map", () => {
  const randMap = (rng: () => number): MapLine[] => {
    // Disjoint ranges on both sides, in a random pairing.
    const n = 1 + Math.floor(rng() * 5);
    const insideStarts = Array.from({ length: n }, (_, i) => i * 1000 + Math.floor(rng() * 100));
    const outsideStarts = Array.from({ length: n }, (_, i) => i * 5000 + Math.floor(rng() * 100)).sort(() => rng() - 0.5);
    return insideStarts.map((s, i) => ({ inside: s, outside: outsideStarts[i]!, length: 1 + Math.floor(rng() * 500) }));
  };
  test("translation round-trips for every mapped ID, in both directions", () => {
    const rng = mulberry32(9);
    for (let t = 0; t < 200; t++) {
      const m = randMap(rng);
      expect(validateMap(m)).toBeNull();
      for (let k = 0; k < 200; k++) {
        const id = Math.floor(rng() * 6000);
        const out = toOutside(m, id);
        if (out !== null) expect(toInside(m, out)).toBe(id);
        const back = toInside(m, id);
        if (back !== null) expect(toOutside(m, back)).toBe(id);
      }
    }
  });
  test("nested maps compose and round-trip", () => {
    const inner = [{ inside: 0, outside: 1000, length: 100 }];
    const outer = [{ inside: 0, outside: 100000, length: 65536 }];
    const chain = [inner, outer];
    expect(toHostNested(chain, 5)).toBe(101005);
    expect(fromHostNested(chain, 101005)).toBe(5);
    expect(toHostNested(chain, 200)).toBeNull();
    expect(fromHostNested(chain, 5)).toBeNull();
  });
  test("the kernel's validity rules", () => {
    expect(validateMap([])).not.toBeNull();
    expect(validateMap([{ inside: 0, outside: 0, length: 0 }])).not.toBeNull();
    expect(validateMap([{ inside: 0, outside: 0, length: 10 }, { inside: 5, outside: 100, length: 10 }])).toContain("inside");
    expect(validateMap([{ inside: 0, outside: 0, length: 10 }, { inside: 100, outside: 5, length: 10 }])).toContain("outside");
    expect(validateMap(Array.from({ length: UID_MAP_MAX_EXTENTS + 1 }, (_, i) => ({ inside: i, outside: i, length: 1 })))).not.toBeNull();
    expect(validateMap(Array.from({ length: UID_MAP_MAX_EXTENTS }, (_, i) => ({ inside: i, outside: i, length: 1 })))).toBeNull();
    expect(validateMap([{ inside: 0, outside: 0, length: 4294967295 }])).toBeNull();
  });
  test("unmapped IDs show as the overflow UID, and the writer rule", () => {
    const m = parseMap("0 100000 65536");
    expect(toOutside(m, 0)).toBe(100000);
    expect(toOutside(m, 33)).toBe(100033);
    expect(displayedInside(m, 0)).toBe(65534);
    expect(displayedInside(m, 100033)).toBe(33);
    expect(mayWriteMap(parseMap("0 1000 1"), 1000, false)).toBe(true);
    expect(mayWriteMap(parseMap("0 0 1"), 1000, false)).toBe(false);
    expect(mayWriteMap(m, 1000, false)).toBe(false);
    expect(mayWriteMap(m, 1000, true)).toBe(true);
  });
});

describe("network namespaces", () => {
  test("the first packet floods an ARP broadcast; the second one does not", () => {
    const n = new NetSim();
    const a = n.send("red", "172.17.0.3");
    expect(a.ok).toBe(true);
    expect(a.deliveredIn).toBe("blue");
    expect(a.arps).toBe(1);
    expect(a.floods).toBe(1);
    expect(a.seenSrc).toBe("172.17.0.2");
    const b = n.send("red", "172.17.0.3");
    expect(b.arps).toBe(0);
    expect(b.floods).toBe(0);
    expect(b.hops.length).toBeLessThan(a.hops.length);
  });
  test("loopback stays in the namespace", () => {
    const r = new NetSim().send("red", "127.0.0.1");
    expect(r.deliveredIn).toBe("red");
    expect(r.hops.every((h) => h.ns === "red")).toBe(true);
  });
  test("traffic to the outside needs forwarding, and NAT changes the source", () => {
    const n = new NetSim();
    const r = n.send("red", "8.8.8.8");
    expect(r.deliveredIn).toBe("internet");
    expect(r.seenSrc).toBe("192.168.1.10");
    const off = new NetSim({ ipForward: false }).send("red", "8.8.8.8");
    expect(off.ok).toBe(false);
    expect(new NetSim({ masquerade: false }).send("red", "8.8.8.8").seenSrc).toBe("172.17.0.2");
  });
  test("the host reaches a container through the bridge, and the longest prefix wins", () => {
    const n = new NetSim();
    expect(n.send("host", "172.17.0.2").deliveredIn).toBe("red");
    expect(n.lookup("red", 0xac110003)!.bits).toBe(16);
    expect(n.lookup("red", 0x08080808)!.bits).toBe(0);
    expect(new NetSim().send("blue", "172.17.0.1").deliveredIn).toBe("host");
  });
  test("an address with no owner on the segment fails", () => {
    expect(new NetSim().send("red", "172.17.0.99").ok).toBe(false);
  });
});

describe("cgroup weights", () => {
  function randomTree(rng: () => number, depth: number, name: string): CgNode {
    const n: CgNode = { name, weight: 1 + Math.floor(rng() * 1000) };
    if (depth > 0 && rng() < 0.75) n.children = Array.from({ length: 1 + Math.floor(rng() * 4) }, (_, i) => randomTree(rng, depth - 1, `${name}c${i}`));
    else n.idle = rng() < 0.2;
    return n;
  }
  test("the shares sum to 100% at each level, and the leaves sum to the root", () => {
    const rng = mulberry32(11);
    for (let t = 0; t < 300; t++) {
      const root = randomTree(rng, 4, "r");
      const rows = weightShares(root);
      for (const s of levelSums(root)) expect(s).toBeCloseTo(1, 9);
      const leaves = rows.filter((r) => { const p = r.path === "/" ? "" : r.path; return !rows.some((x) => x.path.startsWith(`${p}/`) && x.path !== r.path); });
      const total = leaves.reduce((a, r) => a + r.global, 0);
      if (!rows[0]!.idle) expect(total).toBeCloseTo(1, 9);
      for (const r of rows) if (r.idle && r.depth > 0) expect(r.global).toBe(0);
    }
  });
  test("it agrees with the scheduling module when nothing is idle", () => {
    const tree: CgroupNode = { name: "root", weight: 100, children: [{ name: "A", weight: 100, children: [{ name: "a0", weight: 100 }] }, { name: "B", weight: 300, children: [{ name: "b0", weight: 100 }, { name: "b1", weight: 300 }] }] };
    const theirs = cgroupShares(tree);
    const mine = weightShares(tree as CgNode);
    for (const [name, share] of theirs) expect(mine.find((r) => r.name === name)!.global).toBeCloseTo(share, 9);
  });
  test("cpu.max parsing", () => {
    expect(parseCpuMax("max 100000")).toEqual({ quotaUs: null, periodUs: 100000 });
    expect(parseCpuMax("50000 100000")).toEqual({ quotaUs: 50000, periodUs: 100000 });
    expect(parseCpuMax("max")).toEqual({ quotaUs: null, periodUs: 100000 });
    expect(() => parseCpuMax("500 100000")).toThrow();
    expect(() => parseCpuMax("50000 500")).toThrow();
    expect(() => parseCpuMax("50000 2000000")).toThrow();
  });
});

describe("CPU bandwidth", () => {
  test("long-run usage equals the quota, for any thread count", () => {
    for (const threads of [1, 2, 4, 8, 16]) for (const q of [20, 50, 100, 150]) {
      const r = simulateBandwidth({ quotaMs: q, periodMs: 100, threads, horizonMs: 1000, dtMs: 0.1 });
      expect(r.usedMs).toBeLessThanOrEqual(Math.min(threads * 1000, q * 10 + 1e-6) + threads * 5);
      expect(r.usedMs).toBeGreaterThanOrEqual(Math.min(threads * 1000, q * 10) - threads * 5 - 1);
    }
  });
  test("no throttling when the quota covers all threads", () => {
    const r = simulateBandwidth({ quotaMs: 800, periodMs: 100, threads: 8, horizonMs: 300 });
    expect(r.nrThrottled).toBe(0);
    expect(r.throttledMs).toBe(0);
  });
  test("the closed form agrees with the tick model, within one slice", () => {
    for (const [q, n] of [[100, 8], [50, 2], [200, 4], [100, 4]] as const) {
      const r = simulateBandwidth({ quotaMs: q, periodMs: 100, threads: n, horizonMs: 100 });
      const c = throttleStall(q, 100, n);
      const longest = Math.max(...r.rows.map((row) => row[0]!.end - row[0]!.start));
      expect(Math.abs(longest - c.burnMs)).toBeLessThanOrEqual(5 + 1e-6);
    }
  });
  test("burst lets the group save unused quota, and the latency model finishes every request", () => {
    const a = simulateLatency({ quotaMs: 80, periodMs: 100, threads: 8, requestCpuMs: 16, rps: 25, burstMs: 50 });
    const b = simulateLatency({ quotaMs: 80, periodMs: 100, threads: 8, requestCpuMs: 16, rps: 25 });
    expect(a.n).toBe(3000);
    expect(a.p99).toBeLessThan(b.p99);
    const free = simulateLatency({ quotaMs: null, periodMs: 100, threads: 8, requestCpuMs: 16, rps: 25 });
    expect(free.throttledPeriods).toBe(0);
    expect(free.p50).toBeCloseTo(2, 6);
  });
  test("more quota never makes p99 worse in this workload", () => {
    let last = Infinity;
    for (const c of [0.5, 0.6, 0.8, 1, 1.5, 2, 4]) {
      const p = simulateLatency({ quotaMs: c * 100, periodMs: 100, threads: 8, requestCpuMs: 16, rps: 25 }).p99;
      expect(p).toBeLessThanOrEqual(last + 1e-9);
      last = p;
    }
  });
});

describe("memory cgroup", () => {
  test("usage never passes memory.max, for any sequence", () => {
    const rng = mulberry32(21);
    for (let t = 0; t < 100; t++) {
      const m = new Memcg({ maxMiB: 300, highMiB: 200, lowMiB: 50, swapMaxMiB: rng() < 0.5 ? 100 : 0 });
      for (let i = 0; i < 30; i++) {
        const r = rng();
        if (r < 0.4) m.allocAnon("app", Math.floor(rng() * 100));
        else if (r < 0.7) m.readFile(Math.floor(rng() * 100));
        else if (r < 0.85) m.free("app", Math.floor(rng() * 100));
        else if (r < 0.95) m.outsidePressure(50);
        else m.restart("app");
        expect(m.current).toBeLessThanOrEqual(300);
        expect(m.peak).toBeLessThanOrEqual(300);
      }
    }
  });
  test("page cache goes first, so a file read cannot OOM", () => {
    const m = new Memcg({ maxMiB: 300, highMiB: 300 }, [{ name: "app" }]);
    m.readFile(1000);
    expect(m.counters.oom).toBe(0);
    expect(m.current).toBe(300);
    m.allocAnon("app", 200);
    expect(m.file).toBe(100);
    expect(m.counters.oom).toBe(0);
  });
  test("anonymous memory with no swap ends in a cgroup OOM that kills the largest task", () => {
    const m = new Memcg({ maxMiB: 300, highMiB: 300 });
    m.allocAnon("app", 400);
    expect(m.counters.oomKill).toBe(1);
    expect(m.procs[0]!.alive).toBe(false);
    expect(m.procs[1]!.alive).toBe(true);
    expect(m.current).toBe(40);
  });
  test("swap delays the OOM, and memory.oom.group kills all tasks", () => {
    const s = new Memcg({ maxMiB: 300, highMiB: 300, swapMaxMiB: 200 });
    s.allocAnon("app", 400);
    expect(s.counters.oom).toBe(0);
    expect(s.swap).toBeGreaterThan(0);
    const g = new Memcg({ maxMiB: 300, highMiB: 300, oomGroup: true });
    g.allocAnon("app", 400);
    expect(g.counters.oomKill).toBe(2);
    expect(g.procs.every((p) => !p.alive)).toBe(true);
  });
  test("memory.high throttles and does not kill; memory.low stops outside reclaim", () => {
    const m = new Memcg({ maxMiB: 800, highMiB: 200 }, [{ name: "app" }]);
    m.allocAnon("app", 300);
    expect(m.counters.oomKill).toBe(0);
    expect(m.counters.high).toBeGreaterThan(0);
    expect(m.stallMs).toBeGreaterThan(0);
    const l = new Memcg({ maxMiB: 800, highMiB: 800, lowMiB: 100 }, [{ name: "app" }]);
    l.readFile(150);
    expect(l.outsidePressure(100)).toBe(50);
    expect(l.current).toBe(100);
    expect(l.counters.low).toBe(1);
  });
});

describe("classic BPF interpreter", () => {
  const ALLOW = SECCOMP_RET.ALLOW, KILL = SECCOMP_RET.KILL_PROCESS, EPERM = (SECCOMP_RET.ERRNO | 1) >>> 0;
  const CASES: { name: string; prog: Insn[]; d: SeccompData; ret: number; steps: number }[] = [
    { name: "return only", prog: [ins(BPF.RET_K, ALLOW)], d: data(0), ret: ALLOW, steps: 1 },
    { name: "jeq true", prog: [ins(BPF.LD_W_ABS, 0), ins(BPF.JEQ_K, 59, 0, 1), ins(BPF.RET_K, KILL), ins(BPF.RET_K, ALLOW)], d: data(59), ret: KILL, steps: 3 },
    { name: "jeq false", prog: [ins(BPF.LD_W_ABS, 0), ins(BPF.JEQ_K, 59, 0, 1), ins(BPF.RET_K, KILL), ins(BPF.RET_K, ALLOW)], d: data(1), ret: ALLOW, steps: 3 },
    { name: "arch load", prog: [ins(BPF.LD_W_ABS, 4), ins(BPF.JEQ_K, X86, 1, 0), ins(BPF.RET_K, KILL), ins(BPF.RET_K, ALLOW)], d: data(0, [], AUDIT_ARCH.AARCH64), ret: KILL, steps: 3 },
    { name: "low word of args[0]", prog: [ins(BPF.LD_W_ABS, 16), ins(BPF.JEQ_K, 7, 0, 1), ins(BPF.RET_K, ALLOW), ins(BPF.RET_K, KILL)], d: data(0, [0x1_0000_0007n]), ret: ALLOW, steps: 3 },
    { name: "high word of args[0]", prog: [ins(BPF.LD_W_ABS, 20), ins(BPF.JEQ_K, 1, 0, 1), ins(BPF.RET_K, ALLOW), ins(BPF.RET_K, KILL)], d: data(0, [0x1_0000_0007n]), ret: ALLOW, steps: 3 },
    { name: "args[5] offset", prog: [ins(BPF.LD_W_ABS, 56), ins(BPF.RET_A)], d: data(0, [0n, 0n, 0n, 0n, 0n, 0x7fff0000n]), ret: ALLOW, steps: 2 },
    { name: "jset", prog: [ins(BPF.LD_W_ABS, 16), ins(BPF.JSET_K, 0x10000000, 0, 1), ins(BPF.RET_K, EPERM), ins(BPF.RET_K, ALLOW)], d: data(56, [0x10000000n]), ret: EPERM, steps: 3 },
    { name: "jgt unsigned", prog: [ins(BPF.LD_W_ABS, 0), ins(BPF.JGT_K, 5, 0, 1), ins(BPF.RET_K, KILL), ins(BPF.RET_K, ALLOW)], d: data(-1), ret: KILL, steps: 3 },
    { name: "jge at the edge", prog: [ins(BPF.LD_W_ABS, 0), ins(BPF.JGE_K, 5, 0, 1), ins(BPF.RET_K, KILL), ins(BPF.RET_K, ALLOW)], d: data(5), ret: KILL, steps: 3 },
    { name: "ja skips", prog: [ins(BPF.JA, 1), ins(BPF.RET_K, KILL), ins(BPF.RET_K, ALLOW)], d: data(0), ret: ALLOW, steps: 2 },
    { name: "alu and ret a", prog: [ins(BPF.LD_IMM, 0x7fff1234), ins(BPF.ALU_AND_K, 0xffff0000), ins(BPF.RET_A)], d: data(0), ret: ALLOW, steps: 3 },
    { name: "scratch memory and X", prog: [ins(BPF.LD_W_ABS, 0), ins(BPF.ST, 3), ins(BPF.LD_IMM, 0), ins(BPF.LDX_MEM, 3), ins(BPF.TXA), ins(BPF.JEQ_K, 42, 0, 1), ins(BPF.RET_K, ALLOW), ins(BPF.RET_K, KILL)], d: data(42), ret: ALLOW, steps: 7 },
    { name: "errno data", prog: [ins(BPF.RET_K, (SECCOMP_RET.ERRNO | 38) >>> 0)], d: data(0), ret: (SECCOMP_RET.ERRNO | 38) >>> 0, steps: 1 },
  ];
  test.each(CASES)("$name", ({ prog, d, ret, steps }) => {
    expect(validate(prog)).toBeNull();
    const r = run(prog, d);
    expect(r.ret).toBe(ret);
    expect(r.steps.length).toBe(steps);
    // The last step has no next pc, and each pc only moves forward.
    expect(r.steps[r.steps.length - 1]!.nextPc).toBeNull();
    for (let i = 1; i < r.steps.length; i++) expect(r.steps[i]!.pc).toBeGreaterThan(r.steps[i - 1]!.pc);
  });
  const INVALID: { name: string; prog: Insn[]; match: string }[] = [
    { name: "empty", prog: [], match: "instructions" },
    { name: "too long", prog: new Array(4097).fill(ins(BPF.RET_K, ALLOW)), match: "instructions" },
    { name: "jt past the end", prog: [ins(BPF.JEQ_K, 1, 5, 0), ins(BPF.RET_K, ALLOW)], match: "past the end" },
    { name: "jf past the end", prog: [ins(BPF.JEQ_K, 1, 0, 1), ins(BPF.RET_K, ALLOW)], match: "past the end" },
    { name: "ja past the end", prog: [ins(BPF.JA, 1), ins(BPF.RET_K, ALLOW)], match: "past the end" },
    { name: "no final return", prog: [ins(BPF.LD_W_ABS, 0)], match: "last instruction" },
    { name: "misaligned load", prog: [ins(BPF.LD_W_ABS, 2), ins(BPF.RET_K, ALLOW)], match: "aligned" },
    { name: "load past seccomp_data", prog: [ins(BPF.LD_W_ABS, 64), ins(BPF.RET_K, ALLOW)], match: "inside seccomp_data" },
    { name: "opcode seccomp rejects (byte load)", prog: [ins(0x30, 0), ins(BPF.RET_K, ALLOW)], match: "opcode" },
    { name: "scratch index", prog: [ins(BPF.ST, 16), ins(BPF.RET_K, ALLOW)], match: "scratch" },
    { name: "read scratch before a write", prog: [ins(BPF.LD_W_MEM, 0), ins(BPF.RET_K, ALLOW)], match: "before a write" },
    { name: "scratch written on one path only", prog: [ins(BPF.JEQ_K, 0, 0, 1), ins(BPF.ST, 0), ins(BPF.LD_W_MEM, 0), ins(BPF.RET_K, ALLOW)], match: "before a write" },
    { name: "offset wider than 8 bits", prog: [ins(BPF.JEQ_K, 1, 256, 0), ...new Array(300).fill(ins(BPF.RET_K, ALLOW))], match: "8 bits" },
  ];
  test.each(INVALID)("rejects: $name", ({ prog, match }) => {
    expect(validate(prog)).toContain(match);
    expect(() => run(prog, data(0))).toThrow();
  });
  test("random jumps: every program is either rejected or ends, moving only forward", () => {
    const rng = mulberry32(31);
    let ok = 0, rejected = 0;
    for (let t = 0; t < 3000; t++) {
      const n = 1 + Math.floor(rng() * 8);
      const prog: Insn[] = Array.from({ length: n }, () => {
        const r = rng();
        if (r < 0.3) return ins(BPF.LD_W_ABS, rng() < 0.5 ? 0 : 16);
        if (r < 0.7) return ins(BPF.JEQ_K, Math.floor(rng() * 3), Math.floor(rng() * 6), Math.floor(rng() * 6));
        if (r < 0.8) return ins(BPF.JA, Math.floor(rng() * 6));
        return ins(BPF.RET_K, rng() < 0.5 ? ALLOW : KILL);
      });
      const err = validate(prog);
      if (err) { rejected++; continue; }
      ok++;
      const res = run(prog, data(Math.floor(rng() * 3), [BigInt(Math.floor(rng() * 3))]));
      expect(res.steps.length).toBeLessThanOrEqual(n);
    }
    expect(ok).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(100);
  });
  test("the compiler agrees with the meaning of the rules, on random specs and calls", () => {
    const rng = mulberry32(41);
    const acts: RuleAction[] = [{ kind: "allow" }, { kind: "errno", errno: 1 }, { kind: "errno", errno: 38 }, { kind: "trap" }, { kind: "kill" }, { kind: "notify" }, { kind: "log" }];
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rng() * a.length)]!;
    for (let t = 0; t < 400; t++) {
      const rules: Rule[] = Array.from({ length: Math.floor(rng() * 6) }, () => {
        const when = rng() < 0.4 ? { arg: Math.floor(rng() * 6), op: pick(["eq", "ne", "set"] as const), value: Math.floor(rng() * 4) } : undefined;
        return { nr: Math.floor(rng() * 5), action: pick(acts), when };
      });
      const spec = { rules, fallback: pick(acts) };
      const prog = compile(spec);
      expect(validate(prog)).toBeNull();
      for (let k = 0; k < 30; k++) {
        const d = data(rng() < 0.05 ? X32_SYSCALL_BIT + 1 : Math.floor(rng() * 6), Array.from({ length: 6 }, () => BigInt(Math.floor(rng() * 4))), rng() < 0.05 ? AUDIT_ARCH.AARCH64 : X86);
        expect(run(prog, d).ret).toBe(evalSpec(spec, d) >>> 0);
      }
    }
  });
  test("return actions and precedence", () => {
    expect(actionOf(0)).toBe("kill_thread");
    expect(actionOf(0x80000000)).toBe("kill_process");
    expect(actionOf(0x00030000)).toBe("trap");
    expect(actionOf(0x00050001)).toBe("errno");
    expect(actionOf(0x7fc00000)).toBe("user_notif");
    expect(actionOf(0x7ff00000)).toBe("trace");
    expect(actionOf(0x7ffc0000)).toBe("log");
    expect(actionOf(0x7fff0000)).toBe("allow");
    expect(actionOf(0x12340000)).toBe("kill_process");
    expect(strongest("allow", "errno")).toBe("errno");
    expect(strongest("kill_process", "trap")).toBe("kill_process");
    const allow = [ins(BPF.RET_K, ALLOW)], deny = [ins(BPF.RET_K, EPERM)];
    expect(runStack([allow, deny, allow], data(0))).toBe("errno");
    expect(runStack([allow, allow], data(0))).toBe("allow");
  });
});

describe("overlayfs", () => {
  /** What a read must return, computed directly from the layers. */
  function expected(o: Overlay, path: string): string | null {
    for (const l of o.stack) {
      const e = l.files.get(path);
      if (!e) continue;
      return e.kind === "file" ? e.content : null;
    }
    return null;
  }
  test("a read always returns the top-most layer's content", () => {
    const rng = mulberry32(51);
    const paths = ["/a", "/b", "/c", "/d", "/e"];
    for (let t = 0; t < 300; t++) {
      const layer = (name: string) => makeLayer(name, Object.fromEntries(paths.filter(() => rng() < 0.5).map((p) => [p, { size: 1 + Math.floor(rng() * 1000), content: `${name}:${p}` }])));
      const o = new Overlay([layer("l1"), layer("l2"), layer("l3")]);
      for (let k = 0; k < 20; k++) {
        const p = paths[Math.floor(rng() * paths.length)]!;
        const r = rng();
        if (r < 0.4) o.write(p, 10, `w${k}`);
        else if (r < 0.6) o.remove(p);
        for (const q of paths) expect(o.read(q)?.content ?? null).toBe(expected(o, q));
      }
      // The lower layers never change.
      for (const l of o.lower) for (const [, e] of l.files) expect(e.kind === "file" && e.content.startsWith(l.name)).toBe(true);
    }
  });
  test("copy-up happens once and copies the whole file", () => {
    const o = new Overlay(sampleImage());
    const size = 1024 ** 3;
    expect(o.write("/data/seed.db", 1, "x")).toBe(size);
    expect(o.copyUps).toBe(1);
    expect(o.write("/data/seed.db", 1, "y")).toBe(0);
    expect(o.copyUps).toBe(1);
    expect(o.copyUpBytes).toBe(size);
    expect(o.read("/data/seed.db")!.layer).toBe("upper");
    expect(o.lower[0]!.files.get("/data/seed.db")).toMatchObject({ content: "seed data" });
  });
  test("whiteouts hide lower files, and only lower files need one", () => {
    const o = new Overlay(sampleImage());
    o.remove("/etc/passwd");
    expect(o.read("/etc/passwd")).toBeNull();
    expect(o.upper.files.get("/etc/passwd")).toEqual({ kind: "whiteout" });
    expect(o.whiteouts).toBe(1);
    expect(o.list()).not.toContain("/etc/passwd");
    o.write("/tmp/x", 5, "x");
    o.remove("/tmp/x");
    expect(o.upper.files.has("/tmp/x")).toBe(false);
    expect(o.whiteouts).toBe(1);
    // Writing again replaces the whiteout, with no copy-up.
    expect(o.write("/etc/passwd", 7, "new")).toBe(0);
    expect(o.read("/etc/passwd")!.content).toBe("new");
  });
  test("the upper version wins over two lower versions; the top lower layer wins next", () => {
    const o = new Overlay(sampleImage());
    expect(o.read("/app/server")!.content).toBe("server v2");
    expect(o.read("/usr/lib/libssl.so")!.content).toBe("libssl 3");
  });
  test("an opaque directory hides everything below it", () => {
    const o = new Overlay(sampleImage());
    expect(o.read("/app/server")).not.toBeNull();
    o.replaceDir("/app");
    expect(o.read("/app/server")).toBeNull();
    o.write("/app/new", 3, "n");
    expect(o.read("/app/new")!.content).toBe("n");
  });
});

describe("VM models", () => {
  const sizes: NestedPageSize[] = ["4k", "2m", "1g"];
  test("the real two-dimensional walk matches (g+1)(h+1)-1 and the final address", () => {
    for (const guestLevels of [4, 5] as const) for (const hostLevels of [4, 5] as const) for (const guestPage of sizes) for (const hostPage of sizes) {
      const w = realNestedWalk({ guestLevels, hostLevels, guestPage, hostPage });
      expect(w.reads.length).toBe(nestedWalkReads(w.guestDepth, w.hostDepth));
      // Each (row, col) cell holds at most one read, and the numbers are 1..n in order.
      expect(new Set(w.reads.map((r) => `${r.row},${r.col}`)).size).toBe(w.reads.length);
      w.reads.forEach((r, i) => expect(r.n).toBe(i + 1));
      // A guest entry read is the last read of its column.
      for (const r of w.reads) if (r.kind === "guest") expect(r.row).toBe(w.hostDepth);
      // The host maps guest frames at a fixed offset.
      expect(w.dataHpa - w.gpa).toBe(0x100000n * BigInt({ "4k": 1, "2m": 512, "1g": 262144 }[hostPage]) * 4096n);
    }
  });
  test("costs are sums of stages, and direct execution has no exit", () => {
    for (const op of GUEST_OPS) {
      const c = opCost(op);
      expect(c.totalNs).toBeCloseTo(c.stages.reduce((a, s) => a + s.ns, 0), 9);
      if (!c.exits) expect(c.stages.every((s) => s.lane === "guest")).toBe(true);
    }
  });
});
