/** Demos for "Unix domain sockets": SCM_RIGHTS with two fd tables, message boundaries, and loopback TCP against a Unix socket. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, bytes, range, si, toggle, useParams, Banner, MONO } from "../../kit";
import { TCP_LAYERS, UNIX_LAYERS, UdsWorld, pathCost, type PathRow, type RecvResult } from "../../sims/os/ipc";

// ---------------------------------------------------------------- 1. SCM_RIGHTS

interface Rights { w: UdsWorld; say: string; fileFd: number | null; recvFd: number | null; sa: number; sb: number; fileId: number | null; bad?: boolean }

function freshRights(): Rights {
  const w = new UdsWorld();
  w.addProcess("A", { pid: 100, uid: 1000, gid: 1000 });
  w.addProcess("B", { pid: 200, uid: 1000, gid: 1000 });
  // B already has fd 3 open, so that the numbers differ in the two tables.
  w.open("B", "config");
  const [sa, sb] = w.socketpair("stream", "A", "B");
  return { w, say: "A and B share a socket pair. Open a file in A.", fileFd: null, recvFd: null, sa, sb, fileId: null };
}

const ROW_H = 24;
const rowY = (i: number) => 34 + i * ROW_H;

function RightsDiagram({ a, b, queue, file, peerGone }: { a: { fd: number; text: string; hot: boolean }[]; b: { fd: number; text: string; hot: boolean }[]; queue: { data: string; fds: number[] }[]; file: { name: string; refs: number; offset: number; freed: boolean } | null; peerGone: boolean }) {
  const W = 360, TW = 104, CX = 124, CW = 112;
  const H = Math.max(rowY(Math.max(a.length, b.length)) + 4, 170);
  const OY = 92, OH = 66;
  const flying = queue.some((q) => q.fds.length > 0);
  const table = (x: number, title: string, color: string, rows: typeof a) => (
    <g>
      <rect x={x} y={0} width={TW} height={H - 2} rx={5} fill="var(--bg)" stroke={color} strokeWidth={1.5} />
      <text x={x + 7} y={17} fontSize={11.5} fontWeight={600} fill={color}>{title}</text>
      {rows.map((r, i) => (
        <g key={r.fd}>
          <rect x={x + 4} y={rowY(i) - 13} width={TW - 8} height={ROW_H - 4} rx={3} fill={r.hot ? "var(--subtle)" : "transparent"} stroke={r.hot ? "var(--c5)" : "none"} />
          <text x={x + 9} y={rowY(i) + 1} fontSize={11} fontWeight={600} fontFamily={MONO} fill="var(--fg)">{r.fd}</text>
          <text x={x + 25} y={rowY(i) + 1} fontSize={10.5} fontFamily={MONO} fill={r.hot ? "var(--fg)" : "var(--muted)"}>{r.text}</text>
        </g>
      ))}
    </g>
  );
  const links = (rows: typeof a, x0: number, x1: number, color: string) => rows.map((r, i) => (r.hot ? <line key={r.fd} x1={x0} y1={rowY(i) - 3} x2={x1} y2={OY + OH / 2} stroke={color} strokeWidth={1.8} /> : null));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Two fd tables, the socket queue and the open file description" style={{ width: "100%", maxWidth: 620, display: "block", margin: "0 auto" }}>
      {table(0, "fd table of A", "var(--c1)", a)}
      {table(W - TW, "fd table of B", "var(--c2)", b)}
      {file && !file.freed && links(a, TW - 4, CX, "var(--c1)")}
      {file && !file.freed && links(b, W - TW + 4, CX + CW, "var(--c2)")}
      <rect x={CX} y={0} width={CW} height={64} rx={5} fill="var(--subtle)" stroke="var(--border)" />
      <text x={CX + 6} y={15} fontSize={10.5} fill="var(--muted)">Queue of B's socket</text>
      {queue.length === 0 && <text x={CX + 6} y={38} fontSize={11} fill="var(--muted)">{peerGone ? "socket closed" : "empty"}</text>}
      {queue.slice(0, 1).map((q, i) => (
        <g key={i}>
          <rect x={CX + 6} y={22} width={CW - 12} height={34} rx={4} fill="var(--bg)" stroke="var(--c5)" strokeDasharray={q.fds.length ? "4 2" : undefined} strokeWidth={1.5} />
          <text x={CX + 12} y={36} fontSize={10.5} fontFamily={MONO} fill="var(--fg)">skb: "{q.data}"</text>
          <text x={CX + 12} y={50} fontSize={10} fill="var(--c5)">{q.fds.length ? "file in flight" : "no fds"}</text>
        </g>
      ))}
      {flying && file && !file.freed && <line x1={CX + CW / 2} y1={56} x2={CX + CW / 2} y2={OY} stroke="var(--c5)" strokeWidth={1.8} strokeDasharray="4 3" />}
      <rect x={CX} y={OY} width={CW} height={OH} rx={5} fill="var(--bg)" stroke={file && !file.freed ? "var(--c5)" : "var(--border)"} strokeWidth={1.5} />
      <text x={CX + 6} y={OY + 14} fontSize={10.5} fill="var(--muted)">Open file description</text>
      {!file ? <text x={CX + 6} y={OY + 36} fontSize={11} fill="var(--muted)">none yet</text> : (
        <>
          <text x={CX + 6} y={OY + 29} fontSize={10.5} fontFamily={MONO} fill="var(--fg)">{file.name}{file.freed ? " (freed)" : ""}</text>
          <text x={CX + 6} y={OY + 44} fontSize={10.5} fontFamily={MONO} fill="var(--fg)">f_count = {file.refs}</text>
          <text x={CX + 6} y={OY + 58} fontSize={10.5} fontFamily={MONO} fill="var(--fg)">offset = {file.offset}</text>
        </>
      )}
    </svg>
  );
}

export function IpcScmRightsDemo() {
  const [hist, setHist] = useState<Rights[]>(() => [freshRights()]);
  const s = hist[hist.length - 1]!;
  const { w } = s;
  const act = (f: (n: Rights) => void) => {
    const n: Rights = { ...s, w: s.w.clone(), bad: false };
    f(n);
    setHist([...hist, n]);
  };
  const file = s.fileId !== null ? w.ofds.get(s.fileId)! : null;
  const rows = (proc: string, sock: number) => w.procs[proc]!.fds.flatMap((slot, fd) => {
    if (fd < 3 || !slot) return [];
    const o = w.ofds.get(slot.ofd)!;
    const name = fd === sock ? "socket" : o.name;
    return [{ fd, text: name, hot: slot.ofd === s.fileId }];
  });
  const inflight = s.fileId !== null ? w.inflight(s.fileId) : 0;
  const peerGone = w.eps.get(w.ofdOf("A", s.sa)!.endpoint!) ? w.eps.get(w.eps.get(w.ofdOf("A", s.sa)!.endpoint!)!.peer)!.closed : false;
  const queue = s.sb !== -1 && !peerGone ? w.eps.get(w.eps.get(w.ofdOf("A", s.sa)!.endpoint!)!.peer)!.rx : [];
  const canOpen = s.fileFd === null && s.fileId === null;
  const canSend = s.fileFd !== null && !peerGone && inflight === 0;
  const canCloseA = s.fileFd !== null;
  const canRecv = !peerGone && queue.length > 0;
  return (
    <Demo
      title="SCM_RIGHTS"
      actions={<>
        <button className="btn" disabled={hist.length <= 1} onClick={() => setHist(hist.slice(0, -1))}>Back</button>
        <button className="btn ghost" onClick={() => setHist([freshRights()])}>Reset</button>
      </>}
    >
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <button className="btn primary" disabled={!canOpen} onClick={() => act((n) => { n.fileFd = n.w.open("A", "log.txt"); n.fileId = n.w.ofdOf("A", n.fileFd)!.id; n.say = `A opens log.txt and gets fd ${n.fileFd}. One slot points at one description, with 1 reference.`; })}>A: open</button>
        <button className="btn primary" disabled={!canSend} onClick={() => act((n) => { n.w.send("A", n.sa, "x", { fds: [n.fileFd!] }); n.say = "A calls sendmsg with SCM_RIGHTS. The kernel takes a reference and hangs the description on the skb. No fd number travels."; })}>A: sendmsg</button>
        <button className="btn" disabled={!canCloseA} onClick={() => act((n) => { n.w.close("A", n.fileFd!); n.fileFd = null; const o = n.w.ofds.get(n.fileId!)!; n.say = o.freed ? "A closes its fd. That was the last reference, so the kernel frees the description." : "A closes its fd. The description lives on, because another holder has a reference."; })}>A: close</button>
        <button className="btn primary" disabled={!canRecv} onClick={() => act((n) => { const r = n.w.recv("B", n.sb, 10); n.recvFd = r.fds[0] ?? null; n.say = `B calls recvmsg. The kernel installs the description in the lowest free slot of B: fd ${n.recvFd}. The reference moves from the skb to the slot.`; })}>B: recvmsg</button>
        <button className="btn" disabled={s.fileFd === null || !file || file.freed} onClick={() => act((n) => { const v = n.w.advance("A", n.fileFd!, 100); n.say = `A reads 100 bytes. The offset is ${v}, and it lives in the description.`; })}>A: read 100</button>
        <button className="btn" disabled={s.recvFd === null} onClick={() => act((n) => { const v = n.w.advance("B", n.recvFd!, 100); n.say = `B reads 100 bytes. The offset is ${v}: both processes move one offset.`; })}>B: read 100</button>
        <button className="btn" disabled={s.recvFd === null} onClick={() => act((n) => { n.w.close("B", n.recvFd!); n.recvFd = null; const o = n.w.ofds.get(n.fileId!)!; n.say = o.freed ? "B closes its fd. That was the last reference, so the kernel frees the description." : "B closes its fd. A still holds a reference."; })}>B: close</button>
        <button className="btn" disabled={peerGone} onClick={() => act((n) => { n.w.close("B", n.sb); const o = n.fileId !== null ? n.w.ofds.get(n.fileId)! : null; n.say = o?.freed ? "B closes the socket with the message unread. The kernel purges the queue and drops the reference. The description is freed." : "B closes the socket. The kernel purges its receive queue, and drops any references there."; })}>B: close socket</button>
      </div>
      <RightsDiagram a={rows("A", s.sa)} b={rows("B", s.sb)} queue={queue} file={file} peerGone={peerGone} />
      <Banner tone={file?.freed ? "good" : "plain"}>{s.say}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "slots that hold the file", value: s.fileId !== null ? w.slotsOf(s.fileId) : 0 },
          { label: "references in flight", value: inflight },
          { label: "f_count", value: file?.refs ?? 0 },
          { label: "refs = slots + in flight", value: w.checkRefs() === null ? "holds" : "fails" },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- 2. message boundaries

const MB = { n: range({ label: "Read buffer size", min: 1, max: 12, step: 1, default: 4, format: (v) => `${v} bytes` }) };
const MESSAGES = ["AAAAA", "BBB", "CCCCCC"];
const LETTER: Record<string, string> = { A: "var(--c1)", B: "var(--c2)", C: "var(--c5)" };

const Chars = ({ text, lost }: { text: string; lost?: boolean }) => (
  <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, letterSpacing: 1 }}>
    {[...text].map((c, i) => <span key={i} style={{ color: lost ? "var(--c4)" : LETTER[c], textDecoration: lost ? "line-through" : "none" }}>{c}</span>)}
  </span>
);

function runReads(type: "stream" | "seqpacket", n: number, count: number) {
  const w = new UdsWorld();
  w.addProcess("A", { pid: 1, uid: 1, gid: 1 });
  w.addProcess("B", { pid: 2, uid: 1, gid: 1 });
  const [sa, sb] = w.socketpair(type, "A", "B");
  for (const m of MESSAGES) w.send("A", sa, m);
  const out: { r: RecvResult; lostText: string }[] = [];
  for (let i = 0; i < count; i++) {
    const before = w.eps.get(w.ofdOf("B", sb)!.endpoint!)!.rx[0];
    const whole = before ? before.data.slice(before.consumed) : "";
    const r = w.recv("B", sb, n);
    if (r.status !== "ok") break;
    out.push({ r, lostText: r.lost ? whole.slice(whole.length - r.lost) : "" });
  }
  const left = w.eps.get(w.ofdOf("B", sb)!.endpoint!)!.rx.reduce((a, s) => a + s.data.length - s.consumed, 0);
  return { out, left };
}

function ReadColumn({ title, note, res }: { title: string; note: string; res: ReturnType<typeof runReads> }) {
  const got = res.out.reduce((a, x) => a + x.r.data.length, 0);
  const lost = res.out.reduce((a, x) => a + x.r.lost, 0);
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8, minWidth: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>{note}</div>
      <div style={{ display: "grid", gap: 3, minHeight: 92 }}>
        {res.out.length === 0 && <span className="muted" style={{ fontSize: 12 }}>No read yet.</span>}
        {res.out.map((x, i) => (
          <div key={i} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline", fontSize: 11.5 }}>
            <span className="muted" style={{ fontFamily: MONO }}>read {i + 1} = {x.r.data.length}</span>
            <Chars text={x.r.data} />
            {x.r.trunc && <><Chars text={x.lostText} lost /><span style={{ color: "var(--c4)", fontFamily: MONO, fontSize: 10.5 }}>MSG_TRUNC</span></>}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 6, fontSize: 11.5 }} className="muted">bytes read: {got}. Bytes lost: <b style={{ color: lost ? "var(--c4)" : undefined }}>{lost}</b>. Bytes queued: {res.left}.</div>
    </div>
  );
}

export function IpcBoundaryDemo() {
  const P = useParams("os-ipc-bound", MB);
  const n = P.values.n;
  const [reads, setReads] = useState(0);
  const stream = useMemo(() => runReads("stream", n, reads), [n, reads]);
  const seq = useMemo(() => runReads("seqpacket", n, reads), [n, reads]);
  const more = stream.left > 0 || seq.left > 0;
  return (
    <Demo
      title="Three sends, one short buffer"
      actions={<>
        <button className="btn primary" disabled={!more} onClick={() => setReads(reads + 1)}>Read once more</button>
        <button className="btn ghost" onClick={() => setReads(0)}>Reset</button>
      </>}
      controls={<Param spec={MB.n} value={n} onChange={(v) => { P.set("n", v as number); }} />}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 8, fontSize: 12 }}>
        <span className="muted">The sender calls send three times:</span>
        {MESSAGES.map((m) => <span key={m} style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "0 6px" }}><Chars text={m} /></span>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
        <ReadColumn title="SOCK_STREAM" note="A read can cross message edges. It loses nothing." res={stream} />
        <ReadColumn title="SOCK_SEQPACKET" note="One read takes one message. A short buffer loses the tail." res={seq} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- 3. layers and cost

const LOOP = {
  size: range({ label: "Message size", min: 64, max: 65536, log: true, default: 64, format: (v) => bytes(Math.round(v)) }),
  rules: range({ label: "Netfilter rules on each hook", min: 0, max: 100, step: 1, default: 0 }),
  sleeps: toggle({ label: "The reader sleeps and must wake", default: false }),
};

function LayerList({ title, rows, max, color }: { title: string; rows: PathRow[]; max: number; color: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{title}: {rows.length} layers</div>
      <div style={{ display: "grid", gap: 2 }}>
        {rows.map((r, i) => (
          <div key={i} title={r.what} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 62px", gap: 6, alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: MONO, fontSize: 10.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: r.side === "softirq" ? "var(--c5)" : "var(--fg)" }}>{r.name}</div>
              <div style={{ height: 5, borderRadius: 2, background: color, width: `${Math.max(1, (r.ns / max) * 100)}%` }} />
            </div>
            <span className="muted" style={{ fontFamily: MONO, fontSize: 10.5, textAlign: "right" }}>{si(r.ns * 1e-9, "s", 3)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function IpcLoopbackDemo() {
  const P = useParams("os-ipc-loop", LOOP);
  const { size, rules, sleeps } = P.values;
  const o = { bytes: Math.round(size), rules, readerSleeps: sleeps };
  const tcp = pathCost(TCP_LAYERS, o);
  const unix = pathCost(UNIX_LAYERS, o);
  const max = Math.max(...tcp.layers.map((l) => l.ns), ...unix.layers.map((l) => l.ns));
  return (
    <Demo title="One send on loopback TCP and on a Unix socket: a model" controls={<>
      <Param spec={LOOP.size} value={size} onChange={(v) => P.set("size", v as number)} />
      <Param spec={LOOP.rules} value={rules} onChange={(v) => P.set("rules", v as number)} />
      <Param spec={LOOP.sleeps} value={sleeps} onChange={(v) => P.set("sleeps", v as boolean)} />
    </>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <LayerList title="Loopback TCP" rows={tcp.layers} max={max} color="var(--c1)" />
        <LayerList title="Unix stream socket" rows={unix.layers} max={max} color="var(--c2)" />
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "loopback TCP", value: si(tcp.totalNs * 1e-9, "s", 3) },
          { label: "Unix socket", value: si(unix.totalNs * 1e-9, "s", 3) },
          { label: "ratio", value: `${(tcp.totalNs / unix.totalNs).toFixed(2)}×` },
        ]} />
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Each layer's cost is a model input, chosen for scale. Purple names run in softirq context. Hover over a name to see what the layer does.</p>
    </Demo>
  );
}
