/**
 * The network layer (module "ip" of the networking track).
 *
 * - headers.ts: IPv4 headers as bytes (build, parse, checksum, TTL with the RFC 1624 incremental update),
 *   fragmentation, IPv6 headers, extension-header chains and RFC 5952 address text.
 * - cidr.ts: prefixes, subnet facts, special ranges, aggregation, VLSM, and longest-prefix match with a binary trie.
 * - ipnet.ts: IpNet, an IP data plane on PacketNet: hop-by-hop forwarding with ECMP, TTL, MTU, fragmentation, and
 *   ICMP errors (silent, rate-limited and filtering nodes). Later modules can build transports on it.
 * - routing.ts: distance vector step by step (count to infinity, split horizon, poison reverse), Dijkstra frames,
 *   OSPF cost, and both protocols running on packets through a link failure.
 * - bgp.ts: the BGP decision process, Gao-Rexford policy propagation, hijacks, leaks and RPKI origin validation.
 * - nat.ts: NAPT with RFC 4787 mapping and filtering behaviours, NATs on PacketNet, hole punching.
 * - icmp.ts: ICMP messages as bytes, traceroute (classic and Paris) over ECMP, path MTU discovery and black holes.
 */
export * from "./headers";
export * from "./cidr";
export * from "./ipnet";
export * from "./routing";
export * from "./bgp";
export * from "./nat";
export * from "./icmp";
