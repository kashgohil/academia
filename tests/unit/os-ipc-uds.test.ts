/** Unix domain sockets: fd passing, reference counts, message boundaries, namespaces, and the loopback model. */
import { describe, expect, test } from "vitest";
import { PATH_COST, TCP_LAYERS, UDS_FACTS, UNIX_LAYERS, UdsWorld, UnixNames, pathCost } from "../../src/sims/os/ipc";
import { mulberry32 } from "../../src/sims/rng";

const A = { pid: 100, uid: 1000, gid: 1000 };
const B = { pid: 200, uid: 1001, gid: 1001 };

function world(type: "stream" | "seqpacket" | "dgram" = "stream") {
  const w = new UdsWorld();
  w.addProcess("A", A);
  w.addProcess("B", B);
  const [sa, sb] = w.socketpair(type, "A", "B");
  return { w, sa, sb };
}

describe("SCM_RIGHTS", () => {
  test("the file reaches a new number in the receiver, and one description is shared", () => {
    const { w, sa, sb } = world();
    const f = w.open("A", "log.txt");
    const id = w.ofdOf("A", f)!.id;
    w.close("A", w.dup("A", f)); // leaves a gap, so numbers can differ later
    expect(w.send("A", sa, "x", { fds: [f] })).toBe(1);
    expect(w.ofds.get(id)!.refs).toBe(2);
    expect(w.inflight(id)).toBe(1);
    w.open("B", "other"); // takes the lowest free slot in B
    const r = w.recv("B", sb, 10);
    expect(r.data).toBe("x");
    expect(r.fds.length).toBe(1);
    const got = r.fds[0]!;
    expect(got).not.toBe(f);
    expect(w.ofdOf("B", got)!.id).toBe(id);
    expect(w.inflight(id)).toBe(0);
    expect(w.ofds.get(id)!.refs).toBe(2);
    expect(w.checkRefs()).toBeNull();
  });
  test("the offset is shared, and FD_CLOEXEC is not", () => {
    const { w, sa, sb } = world();
    const f = w.open("A", "log.txt");
    w.send("A", sa, "x", { fds: [f] });
    const got = w.recv("B", sb, 10, { cloexec: true }).fds[0]!;
    w.advance("A", f, 100);
    expect(w.ofdOf("B", got)!.offset).toBe(100);
    w.advance("B", got, 5);
    expect(w.ofdOf("A", f)!.offset).toBe(105);
    expect(w.procs.B!.fds[got]!.cloexec).toBe(true);
    expect(w.procs.A!.fds[f]!.cloexec).toBe(false);
  });
  test("the sender may close before the receiver reads: the skb holds a reference", () => {
    const { w, sa, sb } = world();
    const f = w.open("A", "log.txt");
    const id = w.ofdOf("A", f)!.id;
    w.send("A", sa, "x", { fds: [f] });
    w.close("A", f);
    expect(w.ofds.get(id)!.refs).toBe(1);
    expect(w.ofds.get(id)!.freed).toBe(false);
    const got = w.recv("B", sb, 10).fds[0]!;
    expect(w.ofds.get(id)!.freed).toBe(false);
    w.close("B", got);
    expect(w.ofds.get(id)!.freed).toBe(true);
  });
  test("closing the receiver frees what is in flight", () => {
    const { w, sa, sb } = world();
    const f = w.open("A", "log.txt");
    const id = w.ofdOf("A", f)!.id;
    w.send("A", sa, "x", { fds: [f] });
    w.close("A", f);
    w.close("B", sb);
    expect(w.ofds.get(id)!.freed).toBe(true);
    expect(w.checkRefs()).toBeNull();
    expect(w.send("A", sa, "y")).toBe("EPIPE");
  });
  test("a small control buffer drops the extra fds and sets MSG_CTRUNC", () => {
    const { w, sa, sb } = world();
    const f = w.open("A", "a");
    const g = w.open("A", "b");
    const gid = w.ofdOf("A", g)!.id;
    w.send("A", sa, "x", { fds: [f, g] });
    w.close("A", g);
    const r = w.recv("B", sb, 10, { maxFds: 1 });
    expect(r.fds.length).toBe(1);
    expect(r.ctrunc).toBe(true);
    expect(w.ofds.get(gid)!.freed).toBe(true);
    expect(w.checkRefs()).toBeNull();
  });
  test("the fd limit in one message", () => {
    expect(UDS_FACTS.scmMaxFd).toBe(253);
    const { w, sa } = world();
    const f = w.open("A", "a");
    expect(w.send("A", sa, "x", { fds: new Array<number>(254).fill(f) })).toBe("ETOOMANYREFS");
    expect(w.send("A", sa, "x", { fds: new Array<number>(253).fill(f) })).toBe(1);
    expect(w.ofdOf("A", f)!.refs).toBe(254);
    expect(w.checkRefs()).toBeNull();
  });
  test("a stream read stops after the skb that carries fds", () => {
    const { w, sa, sb } = world();
    const f = w.open("A", "a");
    w.send("A", sa, "aa", { fds: [f] });
    w.send("A", sa, "bb");
    const r = w.recv("B", sb, 10);
    expect(r.data).toBe("aa");
    expect(r.fds.length).toBe(1);
    expect(w.recv("B", sb, 10).data).toBe("bb");
  });
});

describe("cycles need the garbage collector", () => {
  test("a socket sent over itself keeps itself alive until unix_gc", () => {
    const { w, sa, sb } = world();
    const bId = w.ofdOf("B", sb)!.id;
    // A sends B's own endpoint into B's queue. B then closes its fd.
    const copy = (() => {
      w.send("B", sb, "");
      return w.dup("B", sb);
    })();
    w.recv("A", sa, 1);
    // A cannot name B's endpoint, so pass it through a helper: B sends to A, and A sends back.
    w.send("B", sb, "h", { fds: [copy] });
    const inA = w.recv("A", sa, 1).fds[0]!;
    w.close("B", copy);
    w.send("A", sa, "c", { fds: [inA] });
    w.close("A", inA);
    w.close("B", sb);
    const o = w.ofds.get(bId)!;
    expect(o.freed).toBe(false);
    expect(o.refs).toBe(1);
    expect(w.slotsOf(bId)).toBe(0);
    expect(w.checkRefs()).toBeNull();
    expect(w.unixGc()).toContain(o.name);
    expect(o.freed).toBe(true);
    expect(w.checkRefs()).toBeNull();
  });
  test("the collector leaves reachable sockets alone", () => {
    const { w, sa, sb } = world();
    const f = w.open("A", "keep");
    w.send("A", sa, "x", { fds: [f] });
    w.close("A", f);
    expect(w.unixGc()).toEqual([]);
    expect(w.recv("B", sb, 10).fds.length).toBe(1);
    expect(w.checkRefs()).toBeNull();
  });
});

describe("property: reference counts stay correct under random operations", () => {
  test("refs = slots + in-flight, and each description is freed exactly when it reaches zero", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const r = mulberry32(seed);
      const w = new UdsWorld();
      w.addProcess("A", A);
      w.addProcess("B", B);
      const pairs = [w.socketpair("stream", "A", "B"), w.socketpair("seqpacket", "A", "B")];
      const procs = ["A", "B"] as const;
      const liveFds = (p: string) => w.procs[p]!.fds.map((s, i) => (s && s.ofd >= 0 ? i : -1)).filter((i) => i >= 0);
      for (let i = 0; i < 300; i++) {
        const p = procs[Math.floor(r() * 2)]!;
        const fds = liveFds(p);
        const x = r();
        if (x < 0.15) w.open(p, `f${i}`);
        else if (x < 0.3 && fds.length) w.dup(p, fds[Math.floor(r() * fds.length)]!);
        else if (x < 0.45 && fds.length) w.close(p, fds[Math.floor(r() * fds.length)]!);
        else if (x < 0.7) {
          const socks = fds.filter((f) => w.ofdOf(p, f)!.kind === "socket");
          if (socks.length) {
            const pass = fds.filter(() => r() < 0.3).slice(0, 3);
            w.send(p, socks[Math.floor(r() * socks.length)]!, "x".repeat(1 + Math.floor(r() * 4)), { fds: pass });
          }
        } else if (x < 0.95) {
          const socks = fds.filter((f) => w.ofdOf(p, f)!.kind === "socket");
          if (socks.length) w.recv(p, socks[Math.floor(r() * socks.length)]!, 1 + Math.floor(r() * 5), { maxFds: r() < 0.2 ? 1 : undefined });
        } else w.unixGc();
        expect(w.checkRefs()).toBeNull();
      }
      void pairs;
      // Close all. After the collector runs, nothing stays alive.
      for (const p of procs) for (const f of liveFds(p)) w.close(p, f);
      expect(w.checkRefs()).toBeNull();
      w.unixGc();
      expect(w.checkRefs()).toBeNull();
      for (const o of w.ofds.values()) expect(o.freed, o.name).toBe(true);
    }
  });
});

describe("credentials", () => {
  test("the kernel fills in the sender's credentials and rejects a lie", () => {
    const { w, sa, sb } = world();
    w.setPasscred("B", sb, true);
    w.send("A", sa, "hi");
    expect(w.recv("B", sb, 10).cred).toEqual(A);
    expect(w.send("A", sa, "hi", { claimCred: { uid: 0 } })).toBe("EPERM");
    expect(w.peerCred("B", sb)).toEqual(A);
    expect(w.peerCred("A", sa)).toEqual(B);
  });
  test("root may claim other IDs", () => {
    const w = new UdsWorld();
    w.addProcess("root", { pid: 1, uid: 0, gid: 0 });
    w.addProcess("B", B);
    const [s, t] = w.socketpair("stream", "root", "B");
    w.setPasscred("B", t, true);
    expect(w.send("root", s, "hi", { claimCred: { uid: 1000 } })).toBe(2);
    expect(w.recv("B", t, 10).cred!.uid).toBe(1000);
  });
  test("a stream read does not join bytes from two senders when it asks for credentials", () => {
    const { w, sa, sb } = world();
    w.addProcess("C", { pid: 300, uid: 7, gid: 7 });
    w.fork("A", "C", { pid: 300, uid: 7, gid: 7 });
    w.setPasscred("B", sb, true);
    w.send("A", sa, "aa");
    w.send("C", sa, "cc");
    expect(w.recv("B", sb, 10)).toMatchObject({ data: "aa", cred: A });
    expect(w.recv("B", sb, 10).data).toBe("cc");
  });
});

describe("message boundaries", () => {
  const send3 = (w: UdsWorld, sa: number) => { w.send("A", sa, "AAAAA"); w.send("A", sa, "BBB"); w.send("A", sa, "CCCCCC"); };
  test("a stream has no boundaries, and a partial read loses nothing", () => {
    const { w, sa, sb } = world("stream");
    send3(w, sa);
    const out: string[] = [];
    for (;;) { const r = w.recv("B", sb, 4); if (r.status !== "ok") break; out.push(r.data); expect(r.lost).toBe(0); }
    expect(out).toEqual(["AAAA", "ABBB", "CCCC", "CC"]);
  });
  test("seqpacket keeps boundaries, and a short read loses the tail", () => {
    const { w, sa, sb } = world("seqpacket");
    send3(w, sa);
    const a = w.recv("B", sb, 4);
    expect(a).toMatchObject({ data: "AAAA", trunc: true, lost: 1 });
    expect(w.recv("B", sb, 4)).toMatchObject({ data: "BBB", trunc: false, lost: 0 });
    expect(w.recv("B", sb, 4)).toMatchObject({ data: "CCCC", trunc: true, lost: 2 });
  });
  test("EOF and errors after close", () => {
    for (const type of ["stream", "seqpacket"] as const) {
      const { w, sa, sb } = world(type);
      w.send("A", sa, "x");
      w.close("A", sa);
      expect(w.recv("B", sb, 10).data).toBe("x");
      expect(w.recv("B", sb, 10).status).toBe("EOF");
      const o = world(type);
      o.w.close("B", o.sb);
      expect(o.w.send("A", o.sa, "x")).toBe("EPIPE");
    }
    const d = world("dgram");
    d.w.close("A", d.sa);
    expect(d.w.recv("B", d.sb, 10).status).toBe("EAGAIN");
    const e = world("dgram");
    e.w.close("B", e.sb);
    expect(e.w.send("A", e.sa, "x")).toBe("ECONNREFUSED");
  });
});

describe("namespaces", () => {
  test("a path socket leaves a file that blocks the next bind", () => {
    const n = new UnixNames();
    const addr = { ns: "path", path: "/run/app.sock" } as const;
    expect(typeof n.bind(addr)).toBe("number");
    expect(n.bind(addr)).toBe("EADDRINUSE");
    n.closeListener(addr);
    expect(n.fileExists("/run/app.sock")).toBe(true);
    expect(n.connect(addr)).toBe("ECONNREFUSED");
    expect(n.bind(addr)).toBe("EADDRINUSE");
    n.unlink("/run/app.sock");
    expect(n.connect(addr)).toBe("ENOENT");
    expect(typeof n.bind(addr)).toBe("number");
  });
  test("an abstract name goes away with its socket", () => {
    const n = new UnixNames();
    const addr = { ns: "abstract", name: "app" } as const;
    expect(typeof n.bind(addr)).toBe("number");
    expect(n.bind(addr)).toBe("EADDRINUSE");
    n.closeListener(addr);
    expect(n.connect(addr)).toBe("ECONNREFUSED");
    expect(typeof n.bind(addr)).toBe("number");
  });
});

describe("facts and the loopback model", () => {
  test("facts", () => {
    expect(UDS_FACTS).toMatchObject({ sunPathLinux: 108, sunPathMacos: 104, sdListenFdsStart: 3, postgresPort: 5432, loopbackMtu: 65536 });
  });
  test("layer counts", () => {
    expect(TCP_LAYERS.length).toBe(14);
    expect(UNIX_LAYERS.length).toBe(6);
  });
  test("quoted costs", () => {
    const o = { bytes: 64, rules: 0, readerSleeps: false };
    const tcp = pathCost(TCP_LAYERS, o);
    const unix = pathCost(UNIX_LAYERS, o);
    expect(tcp.totalNs).toBeCloseTo(1658.75, 2);
    expect(unix.totalNs).toBeCloseTo(648.75, 2);
    expect(tcp.totalNs / unix.totalNs).toBeCloseTo(2.56, 2);
    const asleep = { ...o, readerSleeps: true };
    expect(pathCost(TCP_LAYERS, asleep).totalNs / pathCost(UNIX_LAYERS, asleep).totalNs).toBeCloseTo(1.18, 2);
    const rules = { ...o, rules: 100 };
    expect(pathCost(TCP_LAYERS, rules).totalNs / pathCost(UNIX_LAYERS, rules).totalNs).toBeCloseTo(17.97, 2);
    const big = { ...o, bytes: 65536 };
    expect(pathCost(TCP_LAYERS, big).totalNs / pathCost(UNIX_LAYERS, big).totalNs).toBeCloseTo(1.05, 2);
    expect(PATH_COST.ruleNs).toBe(25);
  });
});
