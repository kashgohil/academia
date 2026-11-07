/**
 * A download that survives a change of network, or not. The client has two paths to the server: Wi-Fi (fast,
 * short RTT) and cellular (slower, longer RTT). At `switchMs` the Wi-Fi link goes down, and the client knows it
 * at once (the operating system reports it).
 *
 * - TCP: a connection is its 4-tuple (addresses and ports). The client's address changes, so the connection is
 *   dead. The application opens a new one over cellular: TCP handshake (1 RTT), TLS 1.3 (1 RTT), and a request
 *   for the rest of the file (half an RTT to reach the server). Bytes that arrived out of order on the old
 *   connection are lost to the application. The new connection starts in slow start.
 * - QUIC: the connection is its connection ID. The client sends its next packet over cellular. The server sees a
 *   known connection ID from a new address, validates the path with PATH_CHALLENGE and PATH_RESPONSE (1 RTT in
 *   this model; RFC 9000 lets a server send a little before that), then goes on. It resets congestion control and
 *   the RTT estimate for the new path, and sends again the packets that were lost on Wi-Fi.
 *
 * Both use the same sender (flow.ts, Reno). Path rates and delays are model inputs.
 */
import { PacketNet } from "..";
import { Reno } from "./controllers";
import { DATA_BYTES, Flow, ccHandlers, type CcMsg } from "./flow";

export interface MigrationOpts {
  /** Packets in the file. */
  packets: number;
  switchMs: number;
  wifiMbps: number;
  wifiRttMs: number;
  cellMbps: number;
  cellRttMs: number;
  durationMs: number;
  sampleMs?: number;
}

export const MIGRATION_DEFAULT: MigrationOpts = {
  packets: 2500, switchMs: 600, wifiMbps: 40, wifiRttMs: 12, cellMbps: 15, cellRttMs: 50, durationMs: 3500, sampleMs: 10,
};

export interface MigrationRun {
  /** [t ms, MB the application has read]. */
  progress: [number, number][];
  /** Time the whole file was read; NaN if not within the run. */
  doneMs: number;
  /** Time from the switch until new data reaches the application again. */
  stallMs: number;
  /** When the server sends again after the switch. */
  resumeMs: number;
}

const S = 0, CORE = 1, WIFI = 2, CELL = 3, C = 4;

export function migrationRun(proto: "tcp" | "quic", o: MigrationOpts = MIGRATION_DEFAULT): MigrationRun {
  let flows: Flow[] = [];
  const net = new PacketNet<CcMsg>(["server", "core", "wifi", "cell", "client"], { seed: 1, record: false }, ccHandlers(() => flows));
  const fast = 1e9;
  const core = 1;
  net.connect(S, CORE, { rate: fast, delay: core });
  // Wi-Fi: RTT = 2 × (core + 1 + last hop). The last hop is the bottleneck, with a queue of 60 packets.
  net.connect(CORE, WIFI, { rate: fast, delay: 1 });
  const wifiLink = net.connect(WIFI, C, { rate: o.wifiMbps * 1e6, delay: o.wifiRttMs / 2 - core - 1, queuePackets: 60 }, { queuePackets: undefined });
  net.connect(CORE, CELL, { rate: fast, delay: 1 });
  net.connect(CELL, C, { rate: o.cellMbps * 1e6, delay: o.cellRttMs / 2 - core - 1, queuePackets: 60 }, { queuePackets: undefined });
  // Before the switch, both ends route over Wi-Fi.
  net.computeRoutes((p) => (p.node === C && p.peer === CELL) || (p.node === CELL && p.peer === C) ? 1e6 : p.spec.delay + 1e-3);

  const first = new Flow(net, { id: 0, src: S, dst: C, cc: new Reno(), packets: o.packets });
  flows = [first];
  net.at(0, () => first.start());
  let resumeMs = NaN;
  let base = 0; // packets the application read on an old TCP connection
  let second: Flow | undefined;

  net.at(o.switchMs, () => {
    net.setLinkUp(wifiLink, false);
    net.computeRoutes();
    if (proto === "quic") {
      first.stop();
      // One way to the server with the client's next packet, then one RTT of path validation.
      resumeMs = o.switchMs + o.cellRttMs / 2 + o.cellRttMs;
      net.at(resumeMs, () => first.restartPath(new Reno()));
    } else {
      first.stop();
      base = first.rcvCum;
      resumeMs = o.switchMs + 2.5 * o.cellRttMs;
      net.at(resumeMs, () => {
        second = new Flow(net, { id: 1, src: S, dst: C, cc: new Reno(), packets: o.packets - base });
        flows = [first, second];
        second.start();
      });
    }
  });

  const progress: [number, number][] = [];
  let doneMs = NaN, stallEnd = NaN;
  const sp = o.sampleMs ?? 10;
  const readPackets = () => (proto === "quic" ? first.rcvCum : second ? base + second.rcvCum : first.stopped ? base : first.rcvCum);
  let atSwitch = 0;
  for (let t = 0; t <= o.durationMs + 1e-9; t += sp) {
    net.at(t, () => {
      const r = readPackets();
      if (Math.abs(t - o.switchMs) < sp / 2) atSwitch = r;
      if (t > o.switchMs && Number.isNaN(stallEnd) && r > atSwitch) stallEnd = t;
      if (r >= o.packets && Number.isNaN(doneMs)) doneMs = t;
      progress.push([t, (r * DATA_BYTES) / 1e6]);
    });
  }
  net.runUntil(o.durationMs);
  return { progress, doneMs, stallMs: stallEnd - o.switchMs, resumeMs };
}
