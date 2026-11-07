/**
 * Networking, Foundations: the models behind "Layers and encapsulation", "Packets and switching" and
 * "Latency, bandwidth and the BDP". Later modules import these.
 *
 * - encap.ts: an HTTP request wrapped in TCP, IPv4 and Ethernet on real bytes (headers as Field lists, checksums,
 *   FCS); the receiver's checks in order; a router hop with an incremental checksum update; corruption runs.
 * - overhead.ts: wire cost of a packet (headers, padding, preamble, gap), MSS, IPv4 and IPv6 fragmentation, tunnels.
 * - switching.ts: circuit vs packet sharing (PacketNet), the binomial overflow of statistical multiplexing,
 *   store-and-forward vs cut-through pipelines, a router queue with Poisson load and bursts, head-of-line blocking.
 * - latency.ts: light in fiber, great-circle RTT bounds, the geostationary RTT, per-hop latency components,
 *   a windowed sender over a bottleneck, and slow-start transfer times.
 */
export * from "./encap";
export * from "./overhead";
export * from "./switching";
export * from "./latency";
