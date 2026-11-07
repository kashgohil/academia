/**
 * Networking, module 2: the link layer. Reference models that later modules can import.
 *
 * - ethernet: MAC addresses (I/G and U/L bits, OUI, multicast mappings), the Ethernet header as a Field list, frame
 *   bytes with padding and a real CRC-32 FCS, FCS checks and the CRC residue, CRC-32 against the Internet checksum
 *   on random error patterns, bytes on the wire (preamble, gap) and frame rates, and the CSMA/CD collision window.
 * - lan: a switched LAN on PacketNet (onReceive + transmit). Hosts run ARP with a Linux-style neighbour cache
 *   (INCOMPLETE, REACHABLE, STALE, DELAY, PROBE, FAILED, PERMANENT). Switches learn MAC addresses, flood, age
 *   entries, tag and untag 802.1Q VLANs on access and trunk ports, run 802.1D spanning tree (or an RSTP-like fast
 *   mode), and can inspect ARP against DHCP-snooping bindings.
 * - scenarios: ready-made runs on lan: ARP on one switch, the neighbour cache over time, ARP spoofing and its
 *   defences, a learning switch, broadcast storms with and without STP, STP election and failover, VLAN leaks.
 * - ipv6: IPv6 address text and the NDP solicited-node multicast address.
 * - wifi: 802.11 airtime of one exchange (DIFS, backoff, RTS/CTS, data, SIFS, ACK or Block Ack, A-MPDU), a
 *   discrete-event DCF simulation with hidden terminals and the NAV, the performance anomaly against airtime
 *   fairness, and rate adaptation from SNR.
 */
export * from "./ethernet";
export * from "./lan";
export * from "./scenarios";
export * from "./ipv6";
export * from "./wifi";
