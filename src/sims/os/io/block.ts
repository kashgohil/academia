/**
 * The block layer: bios, plugging and merging, an elevator on a real disk model, and closed-loop runs of none,
 * mq-deadline and BFQ on an HDD and an NVMe model.
 *
 * Mechanical costs and NAND timings come from src/sims/db/storage/disk.ts. SCHED_MODEL holds the other MODEL INPUTS.
 * SCHED_FACTS holds real kernel defaults.
 */
import { HDDS, SSD_NVME, rotationMs, seekMs, transferMs, type HddSpec } from "../../db/storage/disk";
import { mulberry32 } from "../../rng";

export const SECTOR_BYTES = 512;

export type IoOp = "R" | "W";
/** struct bio in one line: a start sector, a length, a direction. */
export interface Bio { id: number; sector: number; sectors: number; op: IoOp }
/** struct request: bios that the device can do as one contiguous command. */
export interface BlkRequest { id: number; sector: number; sectors: number; op: IoOp; bios: Bio[]; arrivedMs: number }

/** Real defaults. */
export const SCHED_FACTS = {
  /** mq-deadline: read_expire in ms. */
  readExpireMs: 500,
  /** mq-deadline: write_expire in ms. */
  writeExpireMs: 5000,
  /** mq-deadline: requests in one sorted batch. */
  fifoBatch: 16,
  /** mq-deadline: read batches before a write batch must run. */
  writesStarved: 2,
  /** Kyber: read_lat_nsec, in ms. */
  kyberReadTargetMs: 2,
  /** Kyber: write_lat_nsec, in ms. */
  kyberWriteTargetMs: 10,
  /** BFQ: slice_idle, in ms. */
  bfqSliceIdleMs: 8,
  /** BFQ: fifo_expire_sync and fifo_expire_async, in ms. */
  bfqExpireSyncMs: 125,
  bfqExpireAsyncMs: 250,
  /** NVMe limit on I/O queues. */
  nvmeMaxQueues: 65535,
  /** NVMe limit on commands in one queue. */
  nvmeMaxQueueDepth: 65536,
} as const;

/** MODEL INPUTS. */
export const SCHED_MODEL = {
  /** Sectors on the model disk. */
  diskSectors: 1_000_000,
  /** Longest request in the merge stepper, in sectors. It plays the part of max_sectors_kb. */
  maxRequestSectors: 256,
  /** The disk stepper: command overhead for each request that the disk gets. */
  commandMs: 0.5,
  /** NVMe: a write that the drive acknowledges from its buffer. */
  nvmeWriteUs: 100,
  /** Time that a scheduler holds its one lock for one request, or the per-CPU cost for none. */
  noneUs: 0.3,
  mqDeadlineLockUs: 3,
  bfqLockUs: 8,
  /** BFQ model: requests in one budget, for the reader and for the writer. */
  bfqReadBudget: 16,
  bfqWriteBudget: 4,
} as const;

// ------------------------------------------------------------------- merging

export type MergeKind = "back" | "front" | "none";

/** Tries a back merge, then a front merge. It then joins two requests if the new bio closed the gap between them. */
export function submitBio(queue: BlkRequest[], bio: Bio, o: { maxSectors?: number; merge?: boolean; nowMs?: number; nextId?: number } = {}): { kind: MergeKind; joined: boolean; req: BlkRequest } {
  const max = o.maxSectors ?? SCHED_MODEL.maxRequestSectors;
  if (o.merge !== false) {
    for (const r of queue) {
      if (r.op !== bio.op || r.sectors + bio.sectors > max) continue;
      if (r.sector + r.sectors === bio.sector) {
        r.sectors += bio.sectors;
        r.bios.push(bio);
        return { kind: "back", joined: joinNeighbour(queue, r, max), req: r };
      }
      if (bio.sector + bio.sectors === r.sector) {
        r.sector = bio.sector;
        r.sectors += bio.sectors;
        r.bios.unshift(bio);
        return { kind: "front", joined: joinNeighbour(queue, r, max), req: r };
      }
    }
  }
  const req: BlkRequest = { id: o.nextId ?? bio.id, sector: bio.sector, sectors: bio.sectors, op: bio.op, bios: [bio], arrivedMs: o.nowMs ?? 0 };
  queue.push(req);
  return { kind: "none", joined: false, req };
}

function joinNeighbour(queue: BlkRequest[], r: BlkRequest, max: number): boolean {
  for (let k = 0; k < queue.length; k++) {
    const o = queue[k]!;
    if (o === r || o.op !== r.op || o.sectors + r.sectors > max) continue;
    if (r.sector + r.sectors === o.sector) {
      r.sectors += o.sectors; r.bios.push(...o.bios); r.arrivedMs = Math.min(r.arrivedMs, o.arrivedMs);
      queue.splice(k, 1);
      return true;
    }
    if (o.sector + o.sectors === r.sector) {
      r.sector = o.sector; r.sectors += o.sectors; r.bios.unshift(...o.bios); r.arrivedMs = Math.min(r.arrivedMs, o.arrivedMs);
      queue.splice(k, 1);
      return true;
    }
  }
  return false;
}

/** Every sector of every bio, each counted once per bio. A correct merge keeps the same multiset. */
export function sectorsOf(reqs: readonly { bios: Bio[] }[]): number[] {
  const out: number[] = [];
  for (const r of reqs) for (const b of r.bios) for (let i = 0; i < b.sectors; i++) out.push(b.sector + i);
  return out.sort((a, b) => a - b);
}

/** Checks that a request covers its bios with no gap and no overlap, in sector order. */
export function requestIsContiguous(r: BlkRequest): boolean {
  let at = r.sector;
  for (const b of r.bios) {
    if (b.sector !== at || b.op !== r.op) return false;
    at += b.sectors;
  }
  return at === r.sector + r.sectors;
}

// ------------------------------------------------------------------- the elevator stepper

export type ElevatorPolicy = "fifo" | "look" | "deadline";
export const ELEVATOR_LABEL: Record<ElevatorPolicy, string> = { fifo: "none: arrival order", look: "Elevator", deadline: "Elevator + expiry" };

export interface BlockSnap {
  title: string;
  text: string;
  queue: BlkRequest[];
  /** Requests sent to the device, in order. */
  done: BlkRequest[];
  headSector: number;
  /** Where the head was before this step. */
  fromSector: number;
  dir: 1 | -1;
  nowMs: number;
  seekMs: number;
  rotateMs: number;
  transferMs: number;
  merges: number;
  bios: number;
  active?: number;
  /** The last request jumped the queue because it expired. */
  expired?: boolean;
  /** The longest time that any request has waited from arrival to the end of its transfer. */
  maxWaitMs: number;
  /** The time for each finished request, by request id. */
  finishMs: Record<number, number>;
}

export interface BlockScript { label: string; steps: (Bio | "dispatch")[] }

const bio = (id: number, sector: number, sectors = 8, op: IoOp = "R"): Bio => ({ id, sector, sectors, op });

/** Each script is a list of bios, and points where the plug opens and the disk takes a request. */
export const BLOCK_SCRIPTS: Record<"mixed" | "sequential" | "starve", BlockScript> = {
  mixed: {
    label: "Scattered reads",
    steps: [
      bio(1, 620_000), bio(2, 180_000), bio(3, 620_008), bio(4, 900_000), bio(5, 180_008), bio(6, 420_000), bio(7, 620_016), bio(8, 180_016),
      "dispatch", "dispatch",
      bio(9, 760_000), bio(10, 970_000),
      "dispatch", "dispatch", "dispatch", "dispatch",
    ],
  },
  sequential: {
    label: "Three streams",
    steps: [
      bio(1, 100_000, 8, "W"), bio(2, 500_000, 8, "W"), bio(3, 800_000, 8, "W"),
      bio(4, 100_008, 8, "W"), bio(5, 500_008, 8, "W"), bio(6, 800_008, 8, "W"),
      bio(7, 100_016, 8, "W"), bio(8, 500_016, 8, "W"), bio(9, 800_016, 8, "W"),
      bio(10, 99_992, 8, "W"), bio(11, 499_992, 8, "W"), bio(12, 799_992, 8, "W"),
      "dispatch", "dispatch", "dispatch",
    ],
  },
  starve: {
    label: "A far read waits",
    steps: [
      bio(1, 950_000), bio(2, 100_000), bio(3, 110_000),
      ...Array.from({ length: 9 }, (_, i) => [bio(4 + i * 2, 120_000 + i * 20_000), "dispatch" as const, bio(5 + i * 2, 130_000 + i * 20_000), "dispatch" as const]).flat(),
      "dispatch", "dispatch", "dispatch",
    ],
  },
};

const cloneReq = (r: BlkRequest): BlkRequest => ({ ...r, bios: [...r.bios] });

/** Runs a script on a model disk and records one snapshot per step. */
export function runElevator(script: BlockScript, o: { policy: ElevatorPolicy; merge: boolean; expireMs?: number; disk?: HddSpec; startSector?: number }): BlockSnap[] {
  const disk = o.disk ?? HDDS["7200"];
  const expire = o.expireMs ?? 60;
  const queue: BlkRequest[] = [];
  const done: BlkRequest[] = [];
  const out: BlockSnap[] = [];
  let head = o.startSector ?? 0, from = head, dir: 1 | -1 = 1, now = 0, seekT = 0, rotT = 0, xferT = 0, merges = 0, bios = 0, nextReq = 1, maxWait = 0;
  const finishMs: Record<number, number> = {};
  const snap = (title: string, text: string, active?: number, expired?: boolean) => {
    out.push({ title, text, queue: queue.map(cloneReq), done: done.map(cloneReq), headSector: head, fromSector: from, dir, nowMs: now, seekMs: seekT, rotateMs: rotT, transferMs: xferT, merges, bios, active, expired, maxWaitMs: maxWait, finishMs: { ...finishMs } });
  };
  const pickLook = (): number => {
    const scan = (d: number) => {
      let best = -1, bd = Infinity;
      queue.forEach((r, i) => { const dist = (r.sector - head) * d; if (dist >= 0 && dist < bd) { bd = dist; best = i; } });
      return best;
    };
    let p = scan(dir);
    if (p < 0) { dir = dir === 1 ? -1 : 1; p = scan(dir); }
    return p;
  };
  const dispatch = () => {
    if (queue.length === 0) { snap("The queue is empty", "The disk has no work."); return; }
    let i = 0, expired = false;
    if (o.policy !== "fifo") {
      i = pickLook();
      if (o.policy === "deadline") {
        const oldest = queue.reduce((b, r, k) => (r.arrivedMs < queue[b]!.arrivedMs ? k : b), 0);
        if (now - queue[oldest]!.arrivedMs >= expire && oldest !== i) { i = oldest; expired = true; }
      }
    }
    const r = queue.splice(i, 1)[0]!;
    from = head;
    if (r.sector !== head) dir = r.sector > head ? 1 : -1;
    const sk = seekMs(disk, Math.abs(r.sector - head) / SCHED_MODEL.diskSectors);
    const rot = r.sector === head ? 0 : rotationMs(disk) / 2;
    const xfer = transferMs(disk, r.sectors * SECTOR_BYTES);
    seekT += sk; rotT += rot; xferT += xfer; now += sk + rot + xfer + SCHED_MODEL.commandMs;
    head = r.sector + r.sectors;
    finishMs[r.id] = now;
    maxWait = Math.max(maxWait, now - r.arrivedMs);
    done.push(r);
    snap(`Dispatch ${r.bios.length > 1 ? `a merged request of ${r.bios.length} bios` : "one request"}`,
      `${expired ? "This request has waited too long, so it goes first. " : ""}The head moves ${Math.abs(r.sector - from).toLocaleString("en-US")} sectors: ${sk.toFixed(1)} ms of seek${rot ? `, ${rot.toFixed(1)} ms of rotation` : ", and no rotation wait"}.`,
      r.id, expired);
  };
  snap("Start", "The plug is on. Bios wait in the plug list, and the disk sees nothing yet.");
  for (const st of script.steps) {
    if (st === "dispatch") { dispatch(); continue; }
    bios++;
    const res = submitBio(queue, { ...st }, { merge: o.merge, nowMs: now, nextId: nextReq });
    if (res.kind === "none") nextReq++; else merges++;
    if (res.joined) merges++;
    snap(res.kind === "none" ? `Bio at ${st.sector.toLocaleString("en-US")}: new request` : `Bio at ${st.sector.toLocaleString("en-US")}: ${res.kind} merge`,
      res.kind === "none"
        ? (o.merge ? "No request in the queue touches this range, so the block layer makes a new one." : "Merging is off, so each bio becomes its own request.")
        : `This bio ${res.kind === "back" ? "starts where a request ends" : "ends where a request starts"}. It joins the request, with no extra command.${res.joined ? " It also closes a gap, so two requests become one." : ""}`,
      res.req.id);
  }
  while (queue.length) dispatch();
  snap("Done", `All requests finished in ${now.toFixed(1)} ms.`);
  return out;
}

// ------------------------------------------------------------------- closed-loop runs

export type SchedId = "none" | "mq-deadline" | "bfq";
export type SchedDevice = "hdd" | "nvme";
export const SCHED_LABEL: Record<SchedId, string> = { none: "none", "mq-deadline": "mq-deadline", bfq: "BFQ" };

export interface SchedRunOpts { device: SchedDevice; sched: SchedId; qd: number; readShare: number; n?: number; seed?: number }
export interface SchedRun {
  /** Requests per second. */
  iops: number;
  readIops: number;
  writeIops: number;
  /** Milliseconds. */
  readMeanMs: number;
  readP99Ms: number;
  writeMeanMs: number;
  writeP99Ms: number;
  qd: number;
}

interface Pending { kind: IoOp; pos: number; angle: number; arrive: number }

const percentile = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Splits a queue depth between one reader job and one writer job. Each job keeps its own requests in flight, as fio does. */
export const jobDepths = (qd: number, readShare: number) => {
  const r = Math.max(1, Math.round(qd * readShare));
  return { reader: r, writer: Math.max(1, qd - r) };
};

function runHdd(o: SchedRunOpts): SchedRun {
  const disk = HDDS["7200"];
  const rot = rotationMs(disk);
  const rng = mulberry32(o.seed ?? 3);
  const n = o.n ?? 2500;
  const gen = (kind: IoOp, now: number): Pending => ({ kind, pos: rng(), angle: rng(), arrive: now });
  const { reader, writer } = jobDepths(o.qd, o.readShare);
  const q: Pending[] = [];
  for (let i = 0; i < reader; i++) q.push(gen("R", 0));
  for (let i = 0; i < writer; i++) q.push(gen("W", 0));
  let t = 0, head = 0.3;
  // mq-deadline state.
  let batchDir: IoOp = "R", batchLeft = 0, starved = 0;
  // BFQ state.
  let bfqQ: IoOp = "R", bfqLeft: number = SCHED_MODEL.bfqReadBudget, bfqFifoChecked = false;

  const nextUp = (kind: IoOp | null) => {
    let best = -1, bd = Infinity;
    q.forEach((r, i) => {
      if (kind && r.kind !== kind) return;
      // C-LOOK: forward only, then wrap to the lowest address.
      const d = r.pos >= head ? r.pos - head : r.pos - head + 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const oldest = (kind: IoOp) => {
    let best = -1, ba = Infinity;
    q.forEach((r, i) => { if (r.kind === kind && r.arrive < ba) { ba = r.arrive; best = i; } });
    return best;
  };
  const pick = (): number => {
    if (o.sched === "none") return 0;
    if (o.sched === "mq-deadline") {
      const has = (k: IoOp) => q.some((r) => r.kind === k);
      // A batch goes on while a request of its direction lies ahead of the head.
      if (batchLeft > 0 && q.some((r) => r.kind === batchDir && r.pos >= head)) { batchLeft--; return nextUp(batchDir); }
      const reads = has("R"), writes = has("W");
      if (reads && (!writes || starved < SCHED_FACTS.writesStarved)) { batchDir = "R"; if (writes) starved++; }
      else { batchDir = "W"; starved = 0; }
      batchLeft = SCHED_FACTS.fifoBatch - 1;
      const limit = batchDir === "R" ? SCHED_FACTS.readExpireMs : SCHED_FACTS.writeExpireMs;
      const old = oldest(batchDir);
      if (old >= 0 && t - q[old]!.arrive >= limit) return old;
      return nextUp(batchDir);
    }
    // BFQ: one queue at a time for a budget of requests, in sector order inside the queue.
    const other: IoOp = bfqQ === "R" ? "W" : "R";
    if (bfqLeft <= 0 || !q.some((r) => r.kind === bfqQ)) {
      bfqQ = other;
      bfqLeft = bfqQ === "R" ? SCHED_MODEL.bfqReadBudget : SCHED_MODEL.bfqWriteBudget;
      bfqFifoChecked = false;
    }
    bfqLeft--;
    // BFQ looks at the expiry list once per budget, not before each request.
    const old = bfqFifoChecked ? -1 : oldest(bfqQ);
    bfqFifoChecked = true;
    if (old >= 0 && t - q[old]!.arrive >= (bfqQ === "R" ? SCHED_FACTS.bfqExpireSyncMs : SCHED_FACTS.bfqExpireAsyncMs)) return old;
    return nextUp(bfqQ);
  };

  const rl: number[] = [], wl: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = pick();
    const r = q.splice(i, 1)[0]!;
    const sk = seekMs(disk, Math.abs(r.pos - head));
    const at = (t + sk) / rot;
    const wait = (((r.angle - at) % 1) + 1) % 1;
    const service = sk + wait * rot + transferMs(disk, 4096);
    t += service;
    head = r.pos;
    (r.kind === "R" ? rl : wl).push(t - r.arrive);
    q.push(gen(r.kind, t));
  }
  return {
    iops: (n / t) * 1000, readIops: (rl.length / t) * 1000, writeIops: (wl.length / t) * 1000,
    readMeanMs: mean(rl), readP99Ms: percentile(rl, 0.99), writeMeanMs: mean(wl), writeP99Ms: percentile(wl, 0.99), qd: o.qd,
  };
}

function runNvme(o: SchedRunOpts): SchedRun {
  const rng = mulberry32(o.seed ?? 3);
  const n = o.n ?? 12000;
  const readUs = SSD_NVME.overheadUs + SSD_NVME.readUs;
  const writeUs = SCHED_MODEL.nvmeWriteUs;
  const dies = new Float64Array(SSD_NVME.units);
  const lockUs = o.sched === "none" ? SCHED_MODEL.noneUs : o.sched === "mq-deadline" ? SCHED_MODEL.mqDeadlineLockUs : SCHED_MODEL.bfqLockUs;
  const serial = o.sched !== "none";
  let lockFree = 0;
  // A small binary heap of [finish time, kind, arrival].
  const heap: { t: number; kind: IoOp; arrive: number }[] = [];
  const push = (x: { t: number; kind: IoOp; arrive: number }) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p]!.t <= heap[i]!.t) break; [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p; }
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
        if (l < heap.length && heap[l]!.t < heap[m]!.t) m = l;
        if (r < heap.length && heap[r]!.t < heap[m]!.t) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  const submit = (kind: IoOp, now: number) => {
    const lockDone = serial ? Math.max(now, lockFree) + lockUs : now + lockUs;
    if (serial) lockFree = lockDone;
    const d = Math.floor(rng() * dies.length);
    const start = Math.max(lockDone, dies[d]!);
    const end = start + (kind === "R" ? readUs : writeUs);
    dies[d] = end;
    push({ t: end, kind, arrive: now });
  };
  const { reader, writer } = jobDepths(o.qd, o.readShare);
  for (let i = 0; i < reader; i++) submit("R", 0);
  for (let i = 0; i < writer; i++) submit("W", 0);
  const rl: number[] = [], wl: number[] = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    const c = pop();
    t = c.t;
    (c.kind === "R" ? rl : wl).push((c.t - c.arrive) / 1000);
    submit(c.kind, c.t);
  }
  return {
    iops: (n / t) * 1e6, readIops: (rl.length / t) * 1e6, writeIops: (wl.length / t) * 1e6,
    readMeanMs: mean(rl), readP99Ms: percentile(rl, 0.99), writeMeanMs: mean(wl), writeP99Ms: percentile(wl, 0.99), qd: o.qd,
  };
}

/** One closed-loop run at a fixed queue depth. */
export const schedRun = (o: SchedRunOpts): SchedRun => (o.device === "hdd" ? runHdd(o) : runNvme(o));

export const SCHED_DEPTHS: Record<SchedDevice, number[]> = {
  hdd: [2, 4, 8, 16, 32, 64, 128],
  nvme: [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
};

/** The maximum number of IOPS that a scheduler lock allows. */
export const lockCapIops = (sched: SchedId) => (sched === "none" ? Infinity : 1e6 / (sched === "mq-deadline" ? SCHED_MODEL.mqDeadlineLockUs : SCHED_MODEL.bfqLockUs));
