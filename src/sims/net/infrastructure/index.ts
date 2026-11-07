/**
 * Networking, Infrastructure: load balancers, CDNs and anycast. Everything that moves packets runs on PacketNet with
 * the reference TCP of the transport module; models with no links or queues (hashing, queueing, caches, BGP) are
 * plain functions.
 *
 * Load balancers
 * - lbpath.ts: `lbPathRun` — one download through a balancer in NAT, direct-server-return, IP-in-IP tunnel or
 *   full-proxy mode, with real TCP; bytes through the balancer, TTFB, and the addresses on each hop
 *   (`lbHeaderRows`). `AliasStack`: a TcpStack whose nodes can send from another address (a VIP).
 * - lbhash.ts: `changeRun` / `changeMatrix` — open connections when a backend or a balancer is added, removed,
 *   crashes or drains, with modulo, Maglev or random backend choice, with or without connection tracking, behind
 *   hash-threshold or resilient ECMP. `openAfterDrain` for drain timeouts.
 * - lbpolicy.ts: `policyRun` — random, round robin, least connections and the power of two choices on N FCFS servers,
 *   with stale load information and a slow server; `supermarketMean` / `supermarketTail` (Mitzenmacher 2001).
 * - lbhealth.ts: `healthRun` — a failed backend against active health checks, outlier detection and retries;
 *   `retryAmplification`, `budgetAmplification`, `checkDetectWorstS`.
 *
 * CDNs
 * - cdnlatency.ts: `cdnLatencyRun` — TTFB with no CDN, an edge hit, and misses over warm or new origin connections,
 *   TLS 1.3 or 1.2, on PacketNet; `cdnTtfbFormula` in round trips.
 * - cache.ts: LRU, FIFO, LFU and the ideal static cache on a Zipf stream (`zipfStream`, `hitRatio`), Che's
 *   approximation (`cheLru`), cache-key variants (Vary), and `tierRun`: edges and a shield with max-age.
 * - freshness.ts: `freshRun` — one hot object: expiry, the thundering herd, request collapsing,
 *   stale-while-revalidate and stale-if-error during an origin outage, on PacketNet.
 *
 * Anycast
 * - anycast.ts: a world AS graph with five sites of one anycast prefix; `catchments` (BGP with Gao-Rexford policy,
 *   prepending, NO_EXPORT), distance to the nearest site, `inflation`, and `ddosLoad` across sites.
 * - anycasttcp.ts: `anycastTcpRun` — a route change in the middle of a TCP connection; `breakChance`.
 */
export * from "./lbpath";
export * from "./lbhash";
export * from "./lbpolicy";
export * from "./lbhealth";
export * from "./cdnlatency";
export * from "./cache";
export * from "./freshness";
export * from "./anycast";
export * from "./anycasttcp";
