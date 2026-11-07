/**
 * Wi-Fi (802.11) airtime and the DCF (distributed coordination function): CSMA/CA with binary exponential backoff,
 * the ACK, RTS/CTS and the NAV, hidden terminals, aggregation, rate adaptation and airtime fairness.
 *
 * Facts from 802.11 (OFDM PHY, 5 GHz, 20 MHz): slot 9 µs, SIFS 16 µs, DIFS = SIFS + 2 slots = 34 µs, CWmin 15,
 * CWmax 1023, legacy preamble + SIGNAL 20 µs, symbol 4 µs, 16 SERVICE bits + 6 tail bits, data bits per symbol =
 * rate × 4. Frames: QoS data header 26 bytes, FCS 4, LLC/SNAP 8, ACK 14, RTS 20, CTS 14, compressed Block Ack 32,
 * A-MPDU delimiter 4. Short retry limit 7.
 *
 * Model inputs (labelled as such in the lessons): the 40 µs preamble of the HT/VHT rates, the radio range and the
 * path-loss and error-rate curves of the rate-adaptation model. The DCF simulation leaves out EIFS and capture.
 */
import { mulberry32 } from "../../rng";

export const OFDM = { slotUs: 9, sifsUs: 16, difsUs: 34, cwMin: 15, cwMax: 1023, preambleUs: 20, symbolUs: 4, plcpBits: 22 } as const;
export const FRAME = { macHeader: 26, fcs: 4, llc: 8, ack: 14, rts: 20, cts: 14, blockAck: 32, delimiter: 4 } as const;
/** dot11ShortRetryLimit: transmission attempts of a frame before it is dropped. */
export const SHORT_RETRY_LIMIT = 7;

export interface Phy {
  id: string;
  label: string;
  /** Mb/s. */
  rate: number;
  preambleUs: number;
  /** Largest A-MPDU in bytes; 0 = no aggregation (802.11a/g). */
  maxAmpdu: number;
}

export const PHYS: Phy[] = [
  { id: "a6", label: "802.11a, 6 Mb/s", rate: 6, preambleUs: 20, maxAmpdu: 0 },
  { id: "a24", label: "802.11a, 24 Mb/s", rate: 24, preambleUs: 20, maxAmpdu: 0 },
  { id: "a54", label: "802.11a, 54 Mb/s", rate: 54, preambleUs: 20, maxAmpdu: 0 },
  { id: "n150", label: "802.11n, 150 Mb/s", rate: 150, preambleUs: 40, maxAmpdu: 65_535 },
  { id: "ac433", label: "802.11ac, 433 Mb/s", rate: 433.3, preambleUs: 40, maxAmpdu: 1_048_575 },
  { id: "ac867", label: "802.11ac, 867 Mb/s", rate: 866.7, preambleUs: 40, maxAmpdu: 1_048_575 },
];
export const phyById = (id: string) => PHYS.find((p) => p.id === id) ?? PHYS[2]!;

/** Airtime of one PPDU in µs: preamble + whole 4 µs symbols for SERVICE + data + tail bits. */
export function ppduUs(bytes: number, rate: number, preambleUs: number = OFDM.preambleUs): number {
  const bitsPerSymbol = rate * OFDM.symbolUs;
  return preambleUs + OFDM.symbolUs * Math.ceil((OFDM.plcpBits + 8 * bytes) / bitsPerSymbol);
}

/** The rate for an ACK or CTS: the highest basic rate (6, 12, 24 Mb/s) that is not above the data rate. */
export const controlRate = (rate: number) => (rate >= 24 ? 24 : rate >= 12 ? 12 : 6);

/** Bytes of one data MPDU that carries an IP packet of `payload` bytes. */
export const mpduBytes = (payload: number) => FRAME.macHeader + FRAME.llc + payload + FRAME.fcs;

export interface Segment {
  kind: "DIFS" | "backoff" | "RTS" | "CTS" | "SIFS" | "data" | "ACK" | "Block Ack";
  us: number;
}

export interface Airtime {
  segments: Segment[];
  totalUs: number;
  /** IP packets per exchange (1, or the A-MPDU size). */
  packets: number;
  /** IP payload throughput in Mb/s with one station and no collisions. */
  throughput: number;
  /** throughput / PHY rate. */
  efficiency: number;
  /** Microseconds that carry IP payload bits. */
  payloadUs: number;
}

/**
 * One frame exchange with no contention: DIFS, the average backoff (CWmin / 2 slots), optional RTS/CTS, the data
 * (one MPDU, or an A-MPDU of `aggregate` MPDUs), SIFS and the ACK (or Block Ack).
 */
export function airtime(o: { payload: number; phy: Phy; rts: boolean; aggregate: number }): Airtime {
  const { phy } = o;
  const ctl = controlRate(Math.min(phy.rate, 54));
  const segs: Segment[] = [{ kind: "DIFS", us: OFDM.difsUs }, { kind: "backoff", us: (OFDM.cwMin / 2) * OFDM.slotUs }];
  if (o.rts) segs.push({ kind: "RTS", us: ppduUs(FRAME.rts, ctl) }, { kind: "SIFS", us: OFDM.sifsUs }, { kind: "CTS", us: ppduUs(FRAME.cts, ctl) }, { kind: "SIFS", us: OFDM.sifsUs });
  const k = maxAggregate(o.payload, phy, o.aggregate);
  const sub = Math.ceil((FRAME.delimiter + mpduBytes(o.payload)) / 4) * 4;
  const dataBytes = k === 1 ? mpduBytes(o.payload) : k * sub;
  const dataUs = ppduUs(dataBytes, phy.rate, phy.preambleUs);
  segs.push({ kind: "data", us: dataUs }, { kind: "SIFS", us: OFDM.sifsUs });
  segs.push(k === 1 ? { kind: "ACK", us: ppduUs(FRAME.ack, ctl) } : { kind: "Block Ack", us: ppduUs(FRAME.blockAck, ctl) });
  const totalUs = segs.reduce((s, x) => s + x.us, 0);
  const throughput = (k * o.payload * 8) / totalUs;
  return { segments: segs, totalUs, packets: k, throughput, efficiency: throughput / phy.rate, payloadUs: (k * o.payload * 8) / phy.rate };
}

/** How many MPDUs fit in one A-MPDU: at most `want`, at most 64 (the Block Ack window), and within maxAmpdu. */
export function maxAggregate(payload: number, phy: Phy, want: number): number {
  if (!phy.maxAmpdu) return 1;
  const sub = Math.ceil((FRAME.delimiter + mpduBytes(payload)) / 4) * 4;
  return Math.max(1, Math.min(want, 64, Math.floor(phy.maxAmpdu / sub)));
}

// ============================================================================ the DCF, simulated

export interface DcfOpts {
  /** Stations 1..n send to the access point (node 0). Each always has a frame to send. */
  n: number;
  payload: number;
  /** PHY rate of each station in Mb/s (one value for all, or one per station). */
  rate: number | number[];
  cwMin?: number;
  cwMax?: number;
  rts: boolean;
  /** Can station i hear station j (1-based)? Every station hears the AP. Default: all hear all. */
  hears?: (i: number, j: number) => boolean;
  /** Simulated time in µs. */
  durationUs: number;
  seed?: number;
  /** Keep the transmissions that start before this time, for a strip chart. */
  logUs?: number;
}

export interface DcfTx {
  /** 0 = AP. */
  from: number;
  kind: "DATA" | "ACK" | "RTS" | "CTS";
  start: number;
  end: number;
  /** Lost at the AP: another transmission overlapped it there. */
  collided: boolean;
}

export interface DcfResult {
  delivered: number[];
  /** Mb/s of IP payload per station. */
  throughput: number[];
  total: number;
  attempts: number;
  failures: number;
  /** Failed attempts / attempts. */
  failRate: number;
  /** Frames dropped after SHORT_RETRY_LIMIT attempts. */
  drops: number;
  log: DcfTx[];
}

interface Sta {
  busy: number;
  nav: number;
  idleSince: number;
  counter: number;
  countFrom: number;
  cw: number;
  retries: number;
  /** contend: waiting for an idle medium and counting down; tx: sending or waiting for the answer. */
  mode: "contend" | "tx";
  gen: number;
}

/**
 * A discrete-event simulation of the DCF uplink. A station that hears a transmission freezes its backoff; when the
 * medium is idle again it waits DIFS, then counts down one slot at a time. Two stations whose counters reach zero in
 * the same slot both send, and the AP gets neither. A station that cannot hear another (a hidden terminal) does not
 * freeze for it, so their frames can overlap at the AP at any time. With RTS/CTS, the CTS from the AP sets the NAV of
 * every station, hidden or not.
 */
export function dcfRun(o: DcfOpts): DcfResult {
  const rnd = mulberry32(o.seed ?? 1);
  const N = o.n;
  const cwMin = o.cwMin ?? OFDM.cwMin, cwMax = o.cwMax ?? OFDM.cwMax;
  const rateOf = (i: number) => (Array.isArray(o.rate) ? o.rate[i - 1] ?? o.rate[0]! : o.rate);
  const hears = (i: number, j: number) => i === 0 || j === 0 || i === j || (o.hears ? o.hears(i, j) : true);
  const S: Sta[] = Array.from({ length: N + 1 }, () => ({ busy: 0, nav: 0, idleSince: 0, counter: 0, countFrom: 0, cw: cwMin, retries: 0, mode: "contend" as const, gen: 0 }));
  const delivered = new Array<number>(N + 1).fill(0);
  let attempts = 0, failures = 0, drops = 0;
  const log: DcfTx[] = [];
  const active: DcfTx[] = [];
  // Event queue: a binary heap on (time, seq).
  type Ev = { t: number; seq: number; fn: () => void };
  const heap: Ev[] = [];
  let seq = 0, now = 0;
  const push = (t: number, fn: () => void) => {
    heap.push({ t, seq: seq++, fn });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]!.t < heap[i]!.t || (heap[p]!.t === heap[i]!.t && heap[p]!.seq < heap[i]!.seq)) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        const less = (a: Ev, b: Ev) => a.t < b.t || (a.t === b.t && a.seq < b.seq);
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };

  const ctl = (i: number) => controlRate(Math.min(rateOf(i), 54));
  const dataUs = (i: number) => ppduUs(mpduBytes(o.payload), rateOf(i));
  const ackUs = (i: number) => ppduUs(FRAME.ack, ctl(i));
  const rtsUs = (i: number) => ppduUs(FRAME.rts, ctl(i));
  const ctsUs = (i: number) => ppduUs(FRAME.cts, ctl(i));
  const idle = (k: number) => S[k]!.busy === 0 && now >= S[k]!.nav - 1e-9;

  const plan = (k: number) => {
    const s = S[k]!;
    if (s.mode !== "contend" || !idle(k)) return;
    s.gen++;
    const g = s.gen;
    s.countFrom = Math.max(s.idleSince, s.nav) + OFDM.difsUs;
    const at = s.countFrom + s.counter * OFDM.slotUs;
    push(Math.max(at, now), () => {
      if (s.gen !== g || s.mode !== "contend") return;
      s.mode = "tx";
      attempts++;
      if (o.rts) send(k, "RTS", rtsUs(k));
      else send(k, "DATA", dataUs(k));
    });
  };

  const freeze = (k: number) => {
    const s = S[k]!;
    if (s.mode !== "contend") return;
    // A station whose counter reaches zero at this very instant sends anyway: that is how collisions happen.
    const at = s.countFrom + s.counter * OFDM.slotUs;
    if (now >= at - 1e-9 && now >= s.countFrom) return;
    if (now > s.countFrom) s.counter = Math.max(0, s.counter - Math.floor((now - s.countFrom + 1e-9) / OFDM.slotUs));
    s.gen++;
  };

  const backoff = (k: number) => {
    const s = S[k]!;
    s.counter = Math.floor(rnd() * (s.cw + 1));
    s.mode = "contend";
    s.idleSince = Math.max(s.idleSince, now);
    plan(k);
  };

  const setNav = (k: number, until: number) => {
    const s = S[k]!;
    if (until <= s.nav) return;
    const wasIdle = idle(k);
    s.nav = until;
    if (wasIdle) freeze(k);
    push(until, () => {
      if (S[k]!.nav === until && S[k]!.busy === 0) {
        S[k]!.idleSince = until;
        plan(k);
      }
    });
  };

  const send = (from: number, kind: DcfTx["kind"], us: number, after?: (tx: DcfTx) => void) => {
    const tx: DcfTx = { from, kind, start: now, end: now + us, collided: false };
    // At the AP: any overlap with another transmission (or the AP's own) ruins the station frames involved.
    for (const a of active) {
      if (from !== 0 && a.from !== from) tx.collided = true;
      if (a.from !== 0 && from !== a.from) a.collided = true;
    }
    active.push(tx);
    if (o.logUs !== undefined && now < o.logUs) log.push(tx);
    for (let k = 1; k <= N; k++) {
      if (k === from || !hears(k, from)) continue;
      const wasIdle = idle(k);
      S[k]!.busy++;
      if (wasIdle) freeze(k);
    }
    push(tx.end, () => {
      active.splice(active.indexOf(tx), 1);
      for (let k = 1; k <= N; k++) {
        if (k === from || !hears(k, from)) continue;
        S[k]!.busy--;
        if (S[k]!.busy === 0) {
          S[k]!.idleSince = now;
          plan(k);
        }
      }
      if (after) after(tx);
      else if (from !== 0) outcome(tx);
    });
  };

  const success = (k: number) => {
    delivered[k]!++;
    S[k]!.cw = cwMin;
    S[k]!.retries = 0;
    backoff(k);
  };

  const failure = (k: number) => {
    failures++;
    const s = S[k]!;
    s.retries++;
    if (s.retries >= SHORT_RETRY_LIMIT) {
      drops++;
      s.retries = 0;
      s.cw = cwMin;
    } else s.cw = Math.min(2 * s.cw + 1, cwMax);
    backoff(k);
  };

  const outcome = (tx: DcfTx) => {
    const k = tx.from;
    if (tx.kind === "DATA") {
      if (tx.collided) return push(now + OFDM.sifsUs + ackUs(k) + OFDM.slotUs, () => failure(k));
      push(now + OFDM.sifsUs, () => send(0, "ACK", ackUs(k), () => success(k)));
      return;
    }
    // RTS
    const exchange = OFDM.sifsUs + ctsUs(k) + OFDM.sifsUs + dataUs(k) + OFDM.sifsUs + ackUs(k);
    for (let j = 1; j <= N; j++) if (j !== k && hears(j, k)) setNav(j, now + exchange);
    if (tx.collided) return push(now + OFDM.sifsUs + ctsUs(k) + OFDM.slotUs, () => failure(k));
    push(now + OFDM.sifsUs, () =>
      send(0, "CTS", ctsUs(k), () => {
        const rest = OFDM.sifsUs + dataUs(k) + OFDM.sifsUs + ackUs(k);
        for (let j = 1; j <= N; j++) if (j !== k) setNav(j, now + rest);
        push(now + OFDM.sifsUs, () =>
          send(k, "DATA", dataUs(k), (d) => {
            if (d.collided) return push(now + OFDM.sifsUs + ackUs(k) + OFDM.slotUs, () => failure(k));
            push(now + OFDM.sifsUs, () => send(0, "ACK", ackUs(k), () => success(k)));
          }),
        );
      }),
    );
  };

  for (let k = 1; k <= N; k++) backoff(k);
  while (heap.length && heap[0]!.t <= o.durationUs) {
    const e = pop();
    now = e.t;
    e.fn();
  }
  const throughput = delivered.slice(1).map((d) => (d * o.payload * 8) / o.durationUs);
  return {
    delivered: delivered.slice(1),
    throughput,
    total: throughput.reduce((a, b) => a + b, 0),
    attempts,
    failures,
    failRate: attempts ? failures / attempts : 0,
    drops,
    log,
  };
}

// ============================================================================ hidden terminals

/** Model input: how far a station's signal can be sensed, in meters. */
export const SENSE_RANGE = 30;

/**
 * Stations on a line: A at -d/2, the AP at 0, C at +d/2. A and C hear each other only if d ≤ SENSE_RANGE. Both
 * always hear the AP (the model keeps d ≤ 2 × the range).
 */
export function hiddenRun(o: { distance: number; rts: boolean; payload: number; rate: number; durationUs: number; seed?: number; logUs?: number }) {
  const hidden = o.distance > SENSE_RANGE;
  return { hidden, ...dcfRun({ n: 2, payload: o.payload, rate: o.rate, rts: o.rts, hears: () => !hidden, durationUs: o.durationUs, seed: o.seed, logUs: o.logUs }) };
}

// ============================================================================ the performance anomaly and airtime fairness

export interface ShareResult {
  /** Mb/s per station. */
  throughput: number[];
  /** Fraction of airtime per station. */
  airtime: number[];
  total: number;
}

/**
 * The AP sends full frames to stations with different rates, with no collisions. "frames": each station gets the
 * same number of frames (what DCF's equal access gives). "airtime": each gets the same share of time (an airtime
 * fairness scheduler). Each exchange costs the airtime() of one frame at that station's rate.
 */
export function shareAirtime(rates: number[], payload: number, mode: "frames" | "airtime", aggregate = 1): ShareResult {
  const T = rates.map((r) => airtime({ payload, phy: rateToPhy(r), rts: false, aggregate }));
  if (mode === "frames") {
    const cycle = T.reduce((s, t) => s + t.totalUs, 0);
    const throughput = T.map((t) => (t.packets * payload * 8) / cycle);
    return { throughput, airtime: T.map((t) => t.totalUs / cycle), total: throughput.reduce((a, b) => a + b, 0) };
  }
  const throughput = T.map((t) => t.throughput / rates.length);
  return { throughput, airtime: rates.map(() => 1 / rates.length), total: throughput.reduce((a, b) => a + b, 0) };
}

/** A PHY for any legacy rate (the 20 µs preamble, no aggregation). */
export const rateToPhy = (rate: number): Phy => PHYS.find((p) => p.rate === rate) ?? { id: `r${rate}`, label: `${rate} Mb/s`, rate, preambleUs: 20, maxAmpdu: 0 };

// ============================================================================ rate adaptation

export const LEGACY_RATES = [6, 9, 12, 18, 24, 36, 48, 54];

/** Model input: the SNR (dB) at which each 802.11a rate loses half its frames. */
export const SNR_HALF: Record<number, number> = { 6: 4, 9: 6, 12: 8, 18: 11, 24: 14, 36: 18, 48: 22, 54: 24 };

/** Model input: frame error rate as a logistic curve in SNR, 1.5 dB wide. */
export const frameErrorRate = (rate: number, snrDb: number) => 1 / (1 + Math.exp((snrDb - SNR_HALF[rate]!) / 0.75));

/**
 * Model input: log-distance path loss. 20 dBm transmit power, 40 dB loss at 1 m, exponent 3.5 (indoors),
 * noise floor −95 dBm. SNR = 20 − (40 + 35 log₁₀ d) + 95.
 */
export const snrAt = (meters: number) => 75 - 35 * Math.log10(Math.max(1, meters));

export interface RatePoint {
  rate: number;
  fer: number;
  /** Mb/s of IP payload: airtime() throughput × (1 − FER). Failed frames still cost their airtime. */
  goodput: number;
}

export function rateTable(snrDb: number, payload = 1500): RatePoint[] {
  return LEGACY_RATES.map((rate) => {
    const fer = frameErrorRate(rate, snrDb);
    return { rate, fer, goodput: airtime({ payload, phy: rateToPhy(rate), rts: false, aggregate: 1 }).throughput * (1 - fer) };
  });
}

export const bestRate = (snrDb: number, payload = 1500) => rateTable(snrDb, payload).reduce((a, b) => (b.goodput > a.goodput ? b : a));
