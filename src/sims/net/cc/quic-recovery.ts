/**
 * QUIC loss detection (RFC 9002) on a PacketNet path, and what a receiver can hand to the application.
 *
 * The server sends `chunks` pieces of data, one per packet. Every packet has a new packet number: a retransmitted
 * chunk goes in a new packet, so an ACK always names exactly one transmission. The client ACKs every packet at once
 * with the full list of packet numbers it has (QUIC ACK frames carry ranges).
 *
 * Loss detection follows RFC 9002 section 6:
 * - packet threshold: a packet is lost when a packet sent at least kPacketThreshold = 3 later is acknowledged;
 * - time threshold: a packet is lost when it was sent more than kTimeThreshold = 9/8 × max(smoothed_rtt, latest_rtt)
 *   before an acknowledged later packet arrived, or that long ago when the loss timer fires;
 * - probe timeout (PTO): with no ACK for smoothed_rtt + max(4·rttvar, 1 ms) + max_ack_delay, the sender sends a
 *   probe packet that carries the oldest unacknowledged chunk again. A PTO does not declare anything lost.
 * The model starts with an RTT estimate from the handshake (smoothed_rtt = the path RTT, rttvar = half of it).
 * There is no congestion control here: the packets leave `gapMs` apart.
 *
 * `delivery` turns the arrival times into the times the application can read each chunk, for one ordered byte
 * stream (TCP) or for independent streams (QUIC): chunk i belongs to stream i mod `streams`.
 */
import { PacketNet } from "..";

export const K_PACKET_THRESHOLD = 3;
export const K_TIME_THRESHOLD = 9 / 8;
export const K_GRANULARITY_MS = 1;
/** RFC 9000: the default max_ack_delay transport parameter. */
export const MAX_ACK_DELAY_MS = 25;
/** Model inputs: bytes on the wire. */
export const QUIC_DATA_BYTES = 1200;
export const QUIC_ACK_BYTES = 50;

export type QMsg =
  | { k: "data"; pn: number; chunk: number; probe: boolean }
  | { k: "ack"; acked: number[] };

export interface QPacket {
  pn: number;
  chunk: number;
  sentAt: number;
  probe: boolean;
  ackedAt?: number;
  lostAt?: number;
  lostBy?: "packet threshold" | "time threshold";
  /** The packet number that carried this chunk again. */
  resentIn?: number;
}

export interface QEvent {
  t: number;
  kind: "lost" | "pto" | "rtt";
  pn: number;
  text: string;
}

export interface QTransferOpts {
  chunks: number;
  rttMs: number;
  mbps: number;
  /** Time between two packets the sender sends. 0: as fast as the link takes them. */
  gapMs?: number;
  /** Packet numbers the network drops (the learner chooses them). */
  drop?: number[];
  loss?: number;
  seed?: number;
  record?: boolean;
}

export interface QTransfer {
  net: PacketNet<QMsg>;
  packets: QPacket[];
  /** First arrival time of each chunk at the client. */
  arrival: number[];
  events: QEvent[];
  /** Time the sender saw every chunk acknowledged. */
  doneAt: number;
}

export function quicTransfer(o: QTransferOpts): QTransfer {
  const S = 0, C = 1;
  const drop = new Set(o.drop ?? []);
  const net = new PacketNet<QMsg>(["server", "client"], { seed: o.seed ?? 1, record: o.record ?? true });
  net.connect(S, C, { rate: o.mbps * 1e6, delay: o.rttMs / 2, loss: o.loss });
  net.dropIf = (pkt) => pkt.payload.k === "data" && pkt.src === S && drop.has(pkt.payload.pn);
  const packets: QPacket[] = [];
  const events: QEvent[] = [];
  const arrival: number[] = new Array(o.chunks).fill(NaN);
  const queue: number[] = Array.from({ length: o.chunks }, (_, i) => i);
  const chunkAcked = new Array<boolean>(o.chunks).fill(false);
  let srtt = o.rttMs, rttvar = o.rttMs / 2, latest = o.rttMs, minRtt = Infinity;
  let largestAcked = -1, ptoCount = 0, lastSent = 0, doneAt = NaN;
  let timerGen = 0, sending = false;
  const received = new Set<number>();
  const gap = o.gapMs ?? 0;

  const unacked = () => packets.filter((p) => p.ackedAt === undefined && p.lostAt === undefined);
  const sendPacket = (chunk: number, probe: boolean) => {
    const pn = packets.length;
    packets.push({ pn, chunk, sentAt: net.now, probe });
    lastSent = net.now;
    net.send(S, C, QUIC_DATA_BYTES, { k: "data", pn, chunk, probe });
    return pn;
  };
  const pump = () => {
    if (sending) return;
    const next = () => {
      sending = false;
      while (queue.length && chunkAcked[queue[0]!]) queue.shift();
      const c = queue.shift();
      if (c === undefined) return;
      const prev = [...packets].reverse().find((p) => p.chunk === c);
      const pn = sendPacket(c, false);
      if (prev) prev.resentIn = pn;
      armTimer();
      if (queue.length) {
        sending = true;
        net.at(net.now + gap, next);
      }
    };
    if (gap <= 0) {
      while (queue.length) next();
    } else {
      sending = true;
      net.at(Math.max(net.now, lastSent + gap), next);
    }
  };
  const lossDelay = () => Math.max(K_TIME_THRESHOLD * Math.max(srtt, latest), K_GRANULARITY_MS);
  const pto = () => srtt + Math.max(4 * rttvar, K_GRANULARITY_MS) + MAX_ACK_DELAY_MS;
  const detectLost = () => {
    const now = net.now;
    let lossTime = Infinity;
    const lost: QPacket[] = [];
    for (const p of unacked()) {
      if (p.pn > largestAcked) continue;
      if (p.sentAt <= now - lossDelay() + 1e-9) {
        p.lostBy = "time threshold";
      } else if (largestAcked >= p.pn + K_PACKET_THRESHOLD) {
        p.lostBy = "packet threshold";
      } else {
        lossTime = Math.min(lossTime, p.sentAt + lossDelay());
        continue;
      }
      p.lostAt = now;
      lost.push(p);
    }
    for (const p of lost) {
      events.push({ t: now, kind: "lost", pn: p.pn, text: `pn ${p.pn} lost (${p.lostBy})` });
      if (!chunkAcked[p.chunk] && !queue.includes(p.chunk)) queue.push(p.chunk);
    }
    queue.sort((a, b) => a - b);
    return lossTime;
  };
  const armTimer = () => {
    const gen = ++timerGen;
    let lossTime = Infinity;
    for (const p of unacked()) if (p.pn < largestAcked) lossTime = Math.min(lossTime, p.sentAt + lossDelay());
    const out = unacked();
    if (!out.length && lossTime === Infinity) return;
    const isLoss = lossTime < Infinity;
    const t = isLoss ? lossTime : lastSent + pto() * 2 ** ptoCount;
    net.at(t, () => {
      if (gen !== timerGen) return;
      if (isLoss) {
        detectLost();
        pump();
        armTimer();
        return;
      }
      // Probe timeout: send the oldest unacknowledged chunk again in a new packet.
      ptoCount++;
      const oldest = unacked()[0];
      if (!oldest) return;
      events.push({ t: net.now, kind: "pto", pn: oldest.pn, text: `PTO: probe with chunk ${oldest.chunk}` });
      const pn = sendPacket(oldest.chunk, true);
      oldest.resentIn = pn;
      armTimer();
    });
  };

  net.setHandlers({
    onDeliver(node, pkt) {
      const m = pkt.payload;
      if (node === C && m.k === "data") {
        if (Number.isNaN(arrival[m.chunk]!)) arrival[m.chunk] = net.now;
        received.add(m.pn);
        net.send(C, S, QUIC_ACK_BYTES, { k: "ack", acked: [...received].sort((a, b) => a - b) });
        return;
      }
      if (node === S && m.k === "ack") {
        let newLargest = false;
        for (const pn of m.acked) {
          const p = packets[pn]!;
          if (p.ackedAt !== undefined) continue;
          p.ackedAt = net.now;
          chunkAcked[p.chunk] = true;
          if (pn > largestAcked) {
            largestAcked = pn;
            newLargest = true;
          }
        }
        if (newLargest) {
          // RFC 9002 section 5: an RTT sample only when the largest acknowledged packet is newly acknowledged.
          latest = net.now - packets[largestAcked]!.sentAt;
          minRtt = Math.min(minRtt, latest);
          rttvar = 0.75 * rttvar + 0.25 * Math.abs(srtt - latest);
          srtt = 0.875 * srtt + 0.125 * latest;
          events.push({ t: net.now, kind: "rtt", pn: largestAcked, text: `RTT sample ${latest.toFixed(1)} ms from pn ${largestAcked}` });
          ptoCount = 0;
        }
        detectLost();
        if (chunkAcked.every(Boolean) && Number.isNaN(doneAt)) doneAt = net.now;
        pump();
        armTimer();
      }
    },
  });
  pump();
  net.runAll(200_000);
  return { net, packets, arrival, events, doneAt };
}

/**
 * When the application can read each chunk. `ordered`: one byte stream (TCP), so chunk i waits for every earlier
 * chunk. Otherwise chunk i waits only for the earlier chunks of its own stream (QUIC, stream = i mod streams).
 */
export function delivery(arrival: number[], streams: number, ordered: boolean): number[] {
  const out: number[] = [];
  const lastOf = new Array<number>(streams).fill(0);
  let all = 0;
  arrival.forEach((t, i) => {
    const s = i % streams;
    if (ordered) {
      all = Math.max(all, t);
      out.push(all);
    } else {
      lastOf[s] = Math.max(lastOf[s]!, t);
      out.push(lastOf[s]!);
    }
  });
  return out;
}

export interface HolSummary {
  /** Per stream: the time its last chunk can be read. */
  streamDone: number[];
  /** Mean over chunks of (read time − arrival time): time spent waiting in the receive buffer. */
  meanWaitMs: number;
  /** Chunks that arrived but could not be read at once. */
  blocked: number;
}

export function holSummary(arrival: number[], streams: number, ordered: boolean): HolSummary {
  const d = delivery(arrival, streams, ordered);
  const streamDone = new Array<number>(streams).fill(0);
  let wait = 0, blocked = 0;
  d.forEach((t, i) => {
    const s = i % streams;
    streamDone[s] = Math.max(streamDone[s]!, t);
    wait += t - arrival[i]!;
    if (t > arrival[i]! + 1e-9) blocked++;
  });
  return { streamDone, meanWaitMs: wait / arrival.length, blocked };
}
