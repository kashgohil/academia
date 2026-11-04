/**
 * Unix domain sockets with real sharing rules.
 *
 * - An fd table holds slots. A slot points at an open file description (struct file in Linux), which has a reference count,
 *   an offset and status flags. FD_CLOEXEC lives in the slot, not in the description.
 * - send with SCM_RIGHTS: the kernel takes one reference for each fd and hangs them on the skb. No fd number travels.
 * - recv installs each description in the lowest free slot of the receiver. The reference moves from the skb to the slot.
 * - Closing a socket purges its receive queue and drops the references that the skbs hold.
 * - A cycle of sockets that hold each other only through queues cannot reach zero alone. unixGc finds these and frees them,
 *   as unix_gc does in net/unix/garbage.c.
 *
 * The file also has the message rules of the three socket types, the two namespaces, and a loopback cost model.
 */

export const UDS_FACTS = {
  /** SCM_MAX_FD: the most fds in one message. */
  scmMaxFd: 253,
  /** sizeof(sun_path) on Linux. */
  sunPathLinux: 108,
  /** sizeof(sun_path) on macOS. */
  sunPathMacos: 104,
  /** SD_LISTEN_FDS_START: systemd passes sockets from this fd. */
  sdListenFdsStart: 3,
  /** PostgreSQL's default port, which also names its socket file. */
  postgresPort: 5432,
  /** MTU of the Linux loopback device. */
  loopbackMtu: 65536,
} as const;

export type SockType = "stream" | "seqpacket" | "dgram";

export interface Ofd {
  id: number;
  name: string;
  kind: "file" | "socket";
  refs: number;
  offset: number;
  /** O_NONBLOCK and friends. They live here, so two processes share them. */
  nonblock: boolean;
  /** For a socket: its endpoint id. */
  endpoint?: number;
  freed: boolean;
}

export interface FdSlot { ofd: number; cloexec: boolean }

export interface Cred { pid: number; uid: number; gid: number }

export interface Skb {
  data: string;
  /** Bytes already read, for a stream. */
  consumed: number;
  /** Descriptions in flight on this skb. */
  fds: number[];
  cred: Cred;
}

export interface Endpoint {
  id: number;
  type: SockType;
  peer: number;
  rx: Skb[];
  closed: boolean;
  /** SO_PASSCRED. */
  passcred: boolean;
  /** SO_PEERCRED: the peer at connect time. */
  peerCred: Cred | null;
}

export interface RecvResult {
  status: "ok" | "EOF" | "EAGAIN";
  data: string;
  /** MSG_TRUNC: a message did not fit, and its tail is gone. */
  trunc: boolean;
  /** Bytes dropped by this read. */
  lost: number;
  /** MSG_CTRUNC: not all fds fit. */
  ctrunc: boolean;
  /** New fd numbers in the receiver. */
  fds: number[];
  cred: Cred | null;
}

export interface ProcInfo { name: string; cred: Cred; fds: (FdSlot | null)[] }

export class UdsWorld {
  procs: Record<string, ProcInfo> = {};
  ofds = new Map<number, Ofd>();
  eps = new Map<number, Endpoint>();
  private nextOfd = 1;
  private nextEp = 1;
  /** Log of the frees, for a view. */
  freed: string[] = [];

  addProcess(name: string, cred: Cred, firstFree = 3) {
    this.procs[name] = { name, cred, fds: new Array<FdSlot | null>(firstFree).fill({ ofd: -1, cloexec: false }) };
  }

  private newOfd(name: string, kind: Ofd["kind"], endpoint?: number): Ofd {
    const o: Ofd = { id: this.nextOfd++, name, kind, refs: 0, offset: 0, nonblock: false, endpoint, freed: false };
    this.ofds.set(o.id, o);
    return o;
  }

  /** get_unused_fd: the lowest free slot. Slot values of -1 stand for stdin, stdout and stderr. */
  private install(proc: string, ofd: number, cloexec = false): number {
    const t = this.procs[proc]!.fds;
    let fd = t.findIndex((s) => s === null);
    if (fd < 0) { fd = t.length; t.push(null); }
    t[fd] = { ofd, cloexec };
    return fd;
  }

  open(proc: string, name: string): number {
    const o = this.newOfd(name, "file");
    o.refs = 1;
    return this.install(proc, o.id);
  }

  ofdOf(proc: string, fd: number): Ofd | null {
    const s = this.procs[proc]!.fds[fd];
    return s && s.ofd >= 0 ? this.ofds.get(s.ofd) ?? null : null;
  }

  dup(proc: string, fd: number): number {
    const o = this.ofdOf(proc, fd);
    if (!o) throw new Error("EBADF");
    o.refs++;
    return this.install(proc, o.id);
  }

  /** read(2) or lseek through one fd: the offset is in the description, so all fds of it see the change. */
  advance(proc: string, fd: number, n: number): number {
    const o = this.ofdOf(proc, fd);
    if (!o) throw new Error("EBADF");
    o.offset += n;
    return o.offset;
  }

  socketpair(type: SockType, a: string, b: string): [number, number] {
    const ea: Endpoint = { id: this.nextEp++, type, peer: 0, rx: [], closed: false, passcred: false, peerCred: this.procs[b]!.cred };
    const eb: Endpoint = { id: this.nextEp++, type, peer: ea.id, rx: [], closed: false, passcred: false, peerCred: this.procs[a]!.cred };
    ea.peer = eb.id;
    this.eps.set(ea.id, ea);
    this.eps.set(eb.id, eb);
    const oa = this.newOfd(`${type} socket ${ea.id}`, "socket", ea.id);
    const ob = this.newOfd(`${type} socket ${eb.id}`, "socket", eb.id);
    oa.refs = 1;
    ob.refs = 1;
    return [this.install(a, oa.id), this.install(b, ob.id)];
  }

  private endpointOf(proc: string, fd: number): Endpoint {
    const o = this.ofdOf(proc, fd);
    if (!o || o.endpoint === undefined) throw new Error("ENOTSOCK");
    return this.eps.get(o.endpoint)!;
  }

  setPasscred(proc: string, fd: number, on: boolean) { this.endpointOf(proc, fd).passcred = on; }
  peerCred(proc: string, fd: number): Cred | null { return this.endpointOf(proc, fd).peerCred; }

  /**
   * sendmsg. Returns bytes sent, or an errno name. `claimCred` asks to send other credentials: the kernel accepts them only if
   * they match the sender, or if the sender is root (a real kernel checks capabilities).
   */
  send(proc: string, fd: number, data: string, opts: { fds?: number[]; claimCred?: Partial<Cred> } = {}): number | "EPIPE" | "ECONNREFUSED" | "EPERM" | "ETOOMANYREFS" {
    const e = this.endpointOf(proc, fd);
    const peer = this.eps.get(e.peer)!;
    if (peer.closed) return e.type === "dgram" ? "ECONNREFUSED" : "EPIPE";
    const list = opts.fds ?? [];
    if (list.length > UDS_FACTS.scmMaxFd) return "ETOOMANYREFS";
    const own = this.procs[proc]!.cred;
    const cred = { ...own, ...opts.claimCred };
    if (own.uid !== 0 && (cred.uid !== own.uid || cred.gid !== own.gid || cred.pid !== own.pid)) return "EPERM";
    // scm_fp_copy: one reference for each fd, before the skb joins the queue.
    const fds = list.map((n) => {
      const o = this.ofdOf(proc, n);
      if (!o) throw new Error("EBADF");
      o.refs++;
      return o.id;
    });
    peer.rx.push({ data, consumed: 0, fds, cred });
    return data.length;
  }

  /** recvmsg. `maxFds` is the room in the control buffer. */
  recv(proc: string, fd: number, n: number, opts: { maxFds?: number; cloexec?: boolean } = {}): RecvResult {
    const e = this.endpointOf(proc, fd);
    const base: RecvResult = { status: "ok", data: "", trunc: false, lost: 0, ctrunc: false, fds: [], cred: null };
    const peer = this.eps.get(e.peer)!;
    if (e.rx.length === 0) return { ...base, status: peer.closed && e.type !== "dgram" ? "EOF" : "EAGAIN" };
    if (e.type === "stream") {
      let data = "";
      while (data.length < n && e.rx.length) {
        const skb = e.rx[0]!;
        // Never glue bytes from different writers when the reader asks for credentials.
        if (data.length && e.passcred && !sameCred(skb.cred, base.cred ?? skb.cred)) break;
        if (e.passcred && !base.cred) base.cred = skb.cred;
        const k = Math.min(n - data.length, skb.data.length - skb.consumed);
        data += skb.data.slice(skb.consumed, skb.consumed + k);
        skb.consumed += k;
        const hadFds = skb.fds.length > 0;
        if (hadFds) this.detachFds(proc, skb, base, opts);
        if (skb.consumed < skb.data.length) break;
        e.rx.shift();
        if (hadFds) break; // the fds end this read
      }
      return { ...base, data };
    }
    // Datagram and seqpacket: one message for one read. The tail of a long message is gone.
    const skb = e.rx.shift()!;
    this.detachFds(proc, skb, base, opts);
    if (e.passcred) base.cred = skb.cred;
    const data = skb.data.slice(0, n);
    const lost = skb.data.length - data.length;
    return { ...base, data, trunc: lost > 0, lost };
  }

  private detachFds(proc: string, skb: Skb, out: RecvResult, opts: { maxFds?: number; cloexec?: boolean }) {
    const room = opts.maxFds ?? Infinity;
    skb.fds.forEach((id, i) => {
      if (i < room) out.fds.push(this.install(proc, id, !!opts.cloexec));
      else { out.ctrunc = true; this.fput(id); }
    });
    skb.fds = [];
  }

  close(proc: string, fd: number) {
    const t = this.procs[proc]!.fds;
    const s = t[fd];
    if (!s || s.ofd < 0) throw new Error("EBADF");
    t[fd] = null;
    this.fput(s.ofd);
  }

  /** fork: the child gets a copy of the table, and each description gains one reference. */
  fork(parent: string, child: string, cred: Cred) {
    this.procs[child] = { name: child, cred, fds: this.procs[parent]!.fds.map((s) => (s ? { ...s } : null)) };
    for (const s of this.procs[child]!.fds) if (s && s.ofd >= 0) this.ofds.get(s.ofd)!.refs++;
  }

  /** execve: slots with FD_CLOEXEC close. */
  exec(proc: string) {
    this.procs[proc]!.fds.forEach((s, fd) => { if (s?.cloexec) this.close(proc, fd); });
  }

  private fput(id: number) {
    const o = this.ofds.get(id)!;
    if (o.freed) throw new Error(`reference count of ${o.name} went below zero`);
    o.refs--;
    if (o.refs === 0) this.release(o);
  }

  /** The last reference is gone: unix_release for a socket. */
  private release(o: Ofd) {
    o.freed = true;
    this.freed.push(o.name);
    if (o.endpoint === undefined) return;
    const e = this.eps.get(o.endpoint)!;
    e.closed = true;
    const queue = e.rx;
    e.rx = [];
    for (const skb of queue) for (const id of skb.fds) this.fput(id);
  }

  /** How many references the skbs in all queues hold on this description. */
  inflight(id: number): number {
    let n = 0;
    for (const e of this.eps.values()) for (const skb of e.rx) n += skb.fds.filter((x) => x === id).length;
    return n;
  }

  /** Slots in all tables that point at this description. */
  slotsOf(id: number): number {
    let n = 0;
    for (const p of Object.values(this.procs)) for (const s of p.fds) if (s && s.ofd === id) n++;
    return n;
  }

  /** The invariant: refs = slots + in-flight, for each live description, and zero for a freed one. */
  checkRefs(): string | null {
    for (const o of this.ofds.values()) {
      const want = this.slotsOf(o.id) + this.inflight(o.id);
      if (o.refs !== want) return `${o.name}: refs ${o.refs}, but ${want} holders`;
      if (o.freed !== (o.refs === 0)) return `${o.name}: freed = ${o.freed} with refs ${o.refs}`;
    }
    return null;
  }

  /**
   * unix_gc: a socket with references only from queues may be garbage. Start from the descriptions that a process holds.
   * Holding a socket makes the fds in its own receive queue reachable. Any socket not reached holds a dead cycle.
   */
  unixGc(): string[] {
    const reached = new Set<number>();
    const work: number[] = [];
    const reach = (id: number) => { if (!reached.has(id)) { reached.add(id); work.push(id); } };
    for (const o of this.ofds.values()) if (!o.freed && this.slotsOf(o.id) > 0) reach(o.id);
    while (work.length) {
      const o = this.ofds.get(work.pop()!)!;
      if (o.endpoint === undefined) continue;
      for (const skb of this.eps.get(o.endpoint)!.rx) skb.fds.forEach(reach);
    }
    const dead = [...this.ofds.values()].filter((o) => !o.freed && !reached.has(o.id) && o.endpoint !== undefined);
    const names = dead.map((o) => o.name);
    // Empty each dead queue. The references then fall to zero by the normal path.
    const drops: number[] = [];
    for (const o of dead) {
      const e = this.eps.get(o.endpoint!)!;
      for (const skb of e.rx) { drops.push(...skb.fds); skb.fds = []; }
      e.rx = [];
    }
    for (const id of drops) { if (!this.ofds.get(id)!.freed) this.fput(id); }
    return names;
  }

  clone(): UdsWorld {
    const w = new UdsWorld();
    w.procs = Object.fromEntries(Object.entries(this.procs).map(([k, p]) => [k, { ...p, cred: { ...p.cred }, fds: p.fds.map((s) => (s ? { ...s } : null)) }]));
    w.ofds = new Map([...this.ofds].map(([k, o]) => [k, { ...o }]));
    w.eps = new Map([...this.eps].map(([k, e]) => [k, { ...e, rx: e.rx.map((s) => ({ ...s, fds: [...s.fds] })) }]));
    w.nextOfd = this.nextOfd;
    w.nextEp = this.nextEp;
    w.freed = [...this.freed];
    return w;
  }
}

const sameCred = (a: Cred, b: Cred) => a.pid === b.pid && a.uid === b.uid && a.gid === b.gid;

// ---------------------------------------------------------------- the two namespaces

export type SockAddr = { ns: "path"; path: string } | { ns: "abstract"; name: string };

/** bind, close and unlink: a path socket leaves a file behind. An abstract name goes away with its last close. */
export class UnixNames {
  private files = new Set<string>();
  private live = new Map<string, number>();
  private abstract = new Map<string, number>();
  private nextId = 1;

  bind(addr: SockAddr): number | "EADDRINUSE" {
    if (addr.ns === "path") {
      if (this.files.has(addr.path)) return "EADDRINUSE";
      this.files.add(addr.path);
      const id = this.nextId++;
      this.live.set(addr.path, id);
      return id;
    }
    if (this.abstract.has(addr.name)) return "EADDRINUSE";
    const id = this.nextId++;
    this.abstract.set(addr.name, id);
    return id;
  }
  connect(addr: SockAddr): number | "ENOENT" | "ECONNREFUSED" {
    if (addr.ns === "path") {
      if (!this.files.has(addr.path)) return "ENOENT";
      return this.live.get(addr.path) ?? "ECONNREFUSED";
    }
    return this.abstract.get(addr.name) ?? "ECONNREFUSED";
  }
  /** The server closes its listening socket. */
  closeListener(addr: SockAddr) {
    if (addr.ns === "path") this.live.delete(addr.path);
    else this.abstract.delete(addr.name);
  }
  unlink(path: string) { this.files.delete(path); this.live.delete(path); }
  fileExists(path: string) { return this.files.has(path); }
}

// ---------------------------------------------------------------- loopback TCP against a Unix socket

export interface PathLayer {
  name: string;
  what: string;
  /** MODEL INPUT in ns, for a small message. */
  ns: number;
  /** "copy" scales with the size. */
  scale?: "copy" | "copy-cold" | "netfilter" | "wake";
  side: "send" | "softirq" | "recv";
}

/** MODEL INPUTS in ns for one send of a small message: round figures of the right size. */
export const PATH_COST = {
  syscallNs: 150,
  copy4kNs: 400,
  coldCopy4kNs: 800,
  /** One netfilter rule that the packet is checked against. */
  ruleNs: 25,
  /** Hooks on the loopback path: OUTPUT, POSTROUTING, PREROUTING and INPUT. */
  netfilterHooks: 4,
  wakeNs: 5000,
};

export const TCP_LAYERS: PathLayer[] = [
  { name: "syscall entry", what: "sendto reaches tcp_sendmsg", ns: PATH_COST.syscallNs, side: "send" },
  { name: "tcp_sendmsg", what: "lock the socket, copy into an skb", ns: 150, scale: "copy", side: "send" },
  { name: "tcp_write_xmit", what: "windows, congestion control, timers", ns: 200, side: "send" },
  { name: "__tcp_transmit_skb", what: "build the TCP header", ns: 100, side: "send" },
  { name: "ip_queue_xmit", what: "route lookup, IP header", ns: 100, side: "send" },
  { name: "netfilter", what: "OUTPUT, POSTROUTING, then PREROUTING, INPUT", ns: 40, scale: "netfilter", side: "send" },
  { name: "dev_queue_xmit", what: "pick the device, no queue on lo", ns: 60, side: "send" },
  { name: "loopback_xmit", what: "hand the skb to this CPU's backlog", ns: 40, side: "send" },
  { name: "softirq", what: "net_rx_action, process_backlog", ns: 100, side: "softirq" },
  { name: "ip_rcv", what: "check the IP header, deliver locally", ns: 100, side: "softirq" },
  { name: "tcp_v4_rcv", what: "socket lookup, sequence checks, send an ACK", ns: 300, side: "softirq" },
  { name: "sock_def_readable", what: "wake the reader", ns: 50, scale: "wake", side: "softirq" },
  { name: "syscall entry", what: "recvfrom reaches tcp_recvmsg", ns: PATH_COST.syscallNs, side: "recv" },
  { name: "tcp_recvmsg", what: "lock the socket, copy to the user", ns: 100, scale: "copy-cold", side: "recv" },
];

export const UNIX_LAYERS: PathLayer[] = [
  { name: "syscall entry", what: "sendto reaches unix_stream_sendmsg", ns: PATH_COST.syscallNs, side: "send" },
  { name: "unix_stream_sendmsg", what: "allocate an skb, copy into it", ns: 150, scale: "copy", side: "send" },
  { name: "skb_queue_tail", what: "add it to the peer's queue", ns: 30, side: "send" },
  { name: "sk_data_ready", what: "wake the reader", ns: 50, scale: "wake", side: "send" },
  { name: "syscall entry", what: "recvfrom reaches the socket", ns: PATH_COST.syscallNs, side: "recv" },
  { name: "unix_stream_read_generic", what: "copy to the user, free the skb", ns: 100, scale: "copy-cold", side: "recv" },
];

export interface PathOpts { bytes: number; rules: number; readerSleeps: boolean }
export interface PathRow { name: string; what: string; side: PathLayer["side"]; ns: number }
export interface PathCost { layers: PathRow[]; totalNs: number; bytesPerSec: number }

/** Cost of one small send and its read through a list of layers. */
export function pathCost(layers: readonly PathLayer[], o: PathOpts, c = PATH_COST): PathCost {
  const rows = layers.map((l): PathRow => {
    let ns = l.ns;
    if (l.scale === "copy") ns += (o.bytes / 4096) * c.copy4kNs;
    if (l.scale === "copy-cold") ns += (o.bytes / 4096) * c.coldCopy4kNs;
    if (l.scale === "netfilter") ns += o.rules * c.ruleNs * c.netfilterHooks;
    if (l.scale === "wake" && o.readerSleeps) ns += c.wakeNs;
    return { name: l.name, what: l.what, side: l.side, ns };
  });
  const totalNs = rows.reduce((a, r) => a + r.ns, 0);
  return { layers: rows, totalNs, bytesPerSec: (o.bytes / totalNs) * 1e9 };
}
