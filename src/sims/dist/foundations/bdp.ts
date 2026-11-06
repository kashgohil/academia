/**
 * The bandwidth-delay product: the number of bytes "in the pipe" when a link runs at full speed.
 * A sender with a window of W bytes can have at most W bytes unacknowledged, so it sends at most W per round trip:
 * throughput = min(bandwidth, W / RTT). To fill the link, W must be at least bandwidth * RTT.
 */

/** Bytes in flight on a full link: bandwidth (bit/s) times round-trip time (s), in bytes. */
export const bdpBytes = (bitsPerSec: number, rttMs: number) => (bitsPerSec / 8) * (rttMs / 1000);

/** Throughput in bit/s of a sender limited to `window` bytes per round trip. */
export const windowThroughput = (windowBytes: number, rttMs: number, bitsPerSec: number) => Math.min(bitsPerSec, (windowBytes * 8) / (rttMs / 1000));

/** The share of the link that the window fills. */
export const utilization = (windowBytes: number, rttMs: number, bitsPerSec: number) => windowThroughput(windowBytes, rttMs, bitsPerSec) / bitsPerSec;

/** The largest TCP window without the window scale option: a 16-bit field (RFC 7323). */
export const TCP_MAX_UNSCALED = 65_535;
/** The largest window with the largest scale shift, 14 (RFC 7323): about 1 GiB. */
export const TCP_MAX_SCALED = 65_535 * 2 ** 14;

/** Time to send `bytes` with slow start skipped: one RTT of setup, then the transfer at the window-limited rate. */
export const transferMs = (bytes: number, windowBytes: number, rttMs: number, bitsPerSec: number) => rttMs + ((bytes * 8) / windowThroughput(windowBytes, rttMs, bitsPerSec)) * 1000;

/** Time for n calls made one after another, each one round trip plus server time (all in ms). Latency is not zero. */
export const sequentialMs = (calls: number, rttMs: number, serverMs = 0) => calls * (rttMs + serverMs);

/** Round trips used as MODEL INPUTS in the lessons: inside one data center, and across a continent. */
export const RTT_MODEL = { sameDc: 0.5, crossContinent: 70 };
