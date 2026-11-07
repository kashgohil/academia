/**
 * The security module of the networking track: TLS, the Web PKI and VPNs. The cryptography is real and small, tested
 * against the test vectors of the standards; slow and not constant-time, so it is for teaching only.
 *
 * - crypto.ts: SHA-256, HMAC, HKDF, TLS 1.3 HKDF-Expand-Label and Derive-Secret, X25519, AES-128-GCM, RSA-PSS
 *   verification, and a toy RSA (62-bit modulus) for certificate chains.
 * - rfc8448.ts: the messages and keys of the RFC 8448 "Simple 1-RTT Handshake" trace.
 * - tls13.ts: the TLS 1.3 key schedule as a tree of named secrets (`keySchedule`, `rfc8448Schedule`), the record layer
 *   (`sealRecord`, `openRecord`), hello parsing (`parseHello`) and an attacker on the path (`tamperRun`): downgrade
 *   sentinel, AEAD failure on a changed transcript, a CertificateVerify that does not verify, the Finished MAC.
 * - tlsflow.ts: TLS 1.2 and 1.3 handshakes (full, resumed, HelloRetryRequest, PSK, 0-RTT, hybrid post-quantum key
 *   shares) as message scripts on the reference TCP (../transport), with an initial window that limits the first flight.
 * - secrecy.ts: forward secrecy, "record now, decrypt later", with a toy Diffie-Hellman group and session tickets.
 * - pki.ts: X.509 fields, chain building and RFC 5280 path validation, with scenarios that break one link.
 * - merkle.ts: Certificate Transparency's Merkle tree (RFC 9162): tree hashes, inclusion and consistency proofs.
 * - revocation.ts: how long a stolen key stays useful under each revocation method; the CA/B Forum validity schedule.
 * - tunnel.ts: GRE, WireGuard and IPsec ESP encapsulation byte by byte, tunnel MTU, fragmentation and black holes.
 * - meltdown.ts: TCP over TCP against TCP over UDP on a lossy link, with a bulk flow and a voice stream.
 * - wireguard.ts: cryptokey routing, what each observer sees with and without a VPN, and a session run with
 *   WireGuard's timers, NAT mappings and roaming.
 */
export * from "./crypto";
export * from "./rfc8448";
export * from "./tls13";
export * from "./tlsflow";
export * from "./secrecy";
export * from "./pki";
export * from "./merkle";
export * from "./revocation";
export * from "./tunnel";
export * from "./meltdown";
export * from "./wireguard";
