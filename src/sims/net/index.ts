/**
 * Shared code for the networking track.
 *
 * - packet.ts: PacketNet, a deterministic packet-level network. Links have a rate, a propagation delay, a queue limit,
 *   ECN marking and random loss; nodes are handlers; routing tables come from setRoute or computeRoutes. `dumbbell`
 *   builds the usual congestion-control topology. Read its header comment first.
 * - bytes.ts: header fields packed in network byte order, the Internet checksum, CRC-32, hex dumps, IPv4 and MAC text.
 *
 * Each module of the track keeps its own protocols in src/sims/net/<module>/ and builds them on these.
 */
export * from "./packet";
export * from "./bytes";
