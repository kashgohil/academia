/**
 * The transport module: UDP and a reference TCP, built on PacketNet (../packet.ts). Later modules (congestion
 * control, HTTP, TLS, load balancers) import TCP from here.
 *
 * ## TCP in five lines
 *
 * ```ts
 * import { PacketNet } from "../";
 * import { TcpStack, type TcpSegment } from "./transport";
 * const net = new PacketNet<TcpSegment>(["client", "server"]);
 * net.connect(0, 1, { rate: 10e6, delay: 20 });
 * const stack = new TcpStack(net, { nagle: false }).install();       // defaults for every connection
 * stack.listen(1, 80, { onAccept: (s) => (s.onData = (_c, n) => s.write(n)) });  // an echo server
 * const c = stack.connect(0, 1, 80);
 * c.onEstablished = () => c.write(10_000);
 * net.runAll();
 * ```
 *
 * ## The API (tcp.ts)
 *
 * - `new TcpStack(net, defaults)`: every TCP endpoint on one net. `install()` sets the net's handlers. If the net
 *   carries other protocols too, call `stack.deliver(node, pkt)` and `stack.timer(node, tag)` from your own handlers;
 *   both return false for events that are not TCP. TCP timer tags start with "tcp:".
 * - `stack.listen(node, port, { backlog, synCookies, conn, onAccept })` returns a `TcpListener` with SYN-flood stats.
 * - `stack.connect(node, rnode, rport, { port, ...config })` returns a `TcpConn` in SYN_SENT. A port that a
 *   connection still holds (TIME_WAIT included) throws "address in use".
 * - `TcpConn`: `write(n)`, `read(max)` (with `autoRead: false`), `close()` (= shutdown(SHUT_WR): half-close),
 *   `abort()` (RST). Callbacks `onEstablished`, `onData(conn, n)`, `onEof`, `onClose(conn, reason)`.
 *   State: `state` (RFC 9293 names with underscores: SYN_SENT, TIME_WAIT, …), `states` (a timeline), `stats`
 *   (segments, retransmissions, timeouts, fast retransmits, probes, bytes delivered and read), `rtt` (the RFC 6298
 *   estimator), and logs `wndLog`, `rcvLog`, `rttLog` when the net records.
 *   Send side, in relative sequence numbers (SYN = 0, first byte = 1): `una`, `nxt`, `sndWnd`, `rtxq` (each segment
 *   with sacked/lost/retx flags), `pipe()`. Receive side: `rcvNxt`, `rcvWnd`, `rcvBuf`, `unread`, `ooo`.
 * - `stack.events`: state changes, timeouts, fast retransmits, probes, window updates, SYN drops and cookies.
 * - `TcpConfig` (see `TCP_DEFAULTS`): mss, rcvBuf, rcvBufMax, autotune, windowScaling, sack, nagle, delayedAck,
 *   swsAvoid, initialRto/minRto/maxRto, dupThresh, synRetries, synAckRetries, retries, timeWait, isn, autoRead, cc.
 * - Each segment's `info` (not on the wire) carries relative seq and ack, the retransmission count, why it was sent
 *   ("data", "fast", "sack", "rto", "probe", "update", …) and the sending connection: use it to label and filter
 *   packets in diagrams and in `net.dropIf`.
 *
 * ## Congestion control (cc.ts)
 *
 * The sender keeps `pipe() ≤ min(cc.cwnd, peer window)`. A controller implements `CongestionControl`:
 * `cwnd` (bytes), optional `pacingRate`, `init`, `onAck(AckSample)`, `onLoss({ kind: "dupack" | "rto" })`, `onSend`,
 * `onRecoveryEnd`. Pass a factory: `{ cc: () => new MyReno() }`. The default `fixedWindow()` never limits the sender.
 * Note: pacingRate is part of the interface for controllers such as BBR, but this sender does not pace yet.
 *
 * ## The rest
 *
 * - segment.ts: the segment type, flags, `tcpHeaderFields` for HeaderDiagram, 32-bit `wrap`/`unwrap`, `segLabel`.
 * - rto.ts: `RtoEstimator`, `rtoSeries`, `backoffSchedule`, `jitterySamples`.
 * - cookies.ts: SYN cookies in Bernstein's layout (`makeCookie`, `checkCookie`, `cookieFields`).
 * - udp.ts: the UDP header and checksum with the pseudo-header, `sprayRun` (no ordering), `holUdp`/`holTcp`
 *   (head-of-line blocking), `firstResponseMs`.
 * - handshake.ts, reliability.ts, flow.ts: the scenarios behind the lessons' demos.
 *
 * Model limits: the stream is a byte count; segment boundaries are fixed at the first send; no timestamps, urgent
 * data, keepalive, ECN reaction or pacing; the IPv4 + TCP header is 40 bytes plus options, with no link framing.
 */
export * from "./segment";
export * from "./cc";
export * from "./rto";
export * from "./cookies";
export * from "./tcp";
export * from "./udp";
export * from "./handshake";
export * from "./reliability";
export * from "./flow";
