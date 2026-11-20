/**
 * Sims for "The actor model".
 *
 * - runMailbox: an Erlang-style server process on the shared Runtime. For each message it handles, it makes a
 *   synchronous call to a database process and waits for the reply with a selective receive. A selective receive scans
 *   the mailbox from the oldest message. If the receive matches a reference that was created just before the call, the
 *   runtime can skip the messages that were already there (mode `refOpt`). Without that, every call scans the whole
 *   backlog, the service time grows with the backlog, and a burst can tip the server into a backlog that never drains.
 *   `scanNs` (the cost to examine one message) is a model input.
 * - Supervisor: a step model of an OTP supervisor with the restart strategies one_for_one, one_for_all and
 *   rest_for_one, and the restart intensity limit (more than `intensity` restarts within `period` seconds: the
 *   supervisor terminates its children and itself, and its parent decides what to do).
 */
import { Runtime } from "../runtime";

// ---------------------------------------------------------------- selective receive on a long mailbox

export interface MailboxConfig {
  /** The receive matches a fresh reference, so the runtime skips older messages. */
  refOpt: boolean;
  /** Arrivals of new requests (Poisson), per ms. */
  perMs: number;
  /** Work to handle one request, before its call. */
  handleNs: number;
  /** The database's work for one call. */
  callNs: number;
  /** Model input: the server's time to examine one message that does not match. */
  scanNs: number;
  /** Requests already in the mailbox at time 0. */
  burst: number;
  durationNs: number;
  sampleNs: number;
  seed: number;
}

export const MAILBOX_DEFAULTS: MailboxConfig = {
  refOpt: false, perMs: 10, handleNs: 60_000, callNs: 10_000, scanNs: 100, burst: 600, durationNs: 300_000_000, sampleNs: 2_000_000, seed: 5,
};

export interface MailboxResult {
  /** [time ns, messages in the mailbox]. */
  samples: [number, number][];
  handled: number;
  finalLen: number;
  /** Mean messages examined by one call's receive, and the mean time of a call (send to matched reply). */
  scannedPerCall: number;
  callMeanNs: number;
}

/**
 * The backlog above which the server without the optimization cannot keep up. The scan runs while the call is in
 * flight, so one request costs about handle + max(call, scan × backlog). The server falls behind when that reaches
 * 1 / arrival rate: backlog = (1 / rate − handle) / scan. Below it, the backlog drains.
 */
export function tippingBacklog(c: Pick<MailboxConfig, "perMs" | "handleNs" | "callNs" | "scanNs">): number {
  return Math.max(c.callNs, 1e6 / c.perMs - c.handleNs) / c.scanNs;
}

type Msg = { kind: "req" } | { kind: "reply"; ref: number };

export function runMailbox(cfg: Partial<MailboxConfig> = {}): MailboxResult {
  const c = { ...MAILBOX_DEFAULTS, ...cfg };
  const rt = new Runtime({ cores: 3, seed: c.seed, record: false, switchNs: 0, wakeNs: 1_000 });
  const mb: Msg[] = Array.from({ length: c.burst }, () => ({ kind: "req" as const }));
  // A token per delivered message, so that the server can park until something new arrives.
  const notify = rt.channel<number>("notify", Infinity);
  const dbq = rt.channel<number>("db", Infinity);
  const deliver = (t: { trySend: (ch: typeof notify, v: number) => boolean }, m: Msg) => {
    mb.push(m);
    t.trySend(notify, 0);
  };
  const out = { handled: 0, scanned: 0, calls: 0, callNs: 0 };
  const samples: [number, number][] = [];
  rt.spawn("clients", function* (t) {
    for (;;) {
      yield* t.sleep(-(1e6 / c.perMs) * Math.log(1 - t.rand()));
      if (t.now() > c.durationNs) return;
      deliver(t, { kind: "req" });
    }
  });
  rt.spawn("db", function* (t) {
    for (;;) {
      const r = yield* t.recv(dbq);
      if (!r.ok) return;
      yield* t.work(c.callNs, "query");
      deliver(t, { kind: "reply", ref: r.value });
    }
  });
  rt.spawn("sampler", function* (t) {
    while (t.now() <= c.durationNs) {
      samples.push([t.now(), mb.length]);
      yield* t.sleep(c.sampleNs);
    }
  });
  rt.spawn("server", function* (t) {
    const drain = () => {
      while (t.tryRecv(notify)) { /* each token is one delivered message */ }
    };
    for (let ref = 1; t.now() < c.durationNs; ref++) {
      // The main loop's receive matches any message: it takes the oldest one.
      drain();
      if (!mb.length) {
        yield* t.recv(notify);
        continue;
      }
      mb.shift();
      yield* t.work(c.handleNs, "handle");
      // gen_server:call: send the request, then a selective receive for the reply with this ref.
      const start = t.now();
      let pos = c.refOpt ? mb.length : 0;
      t.trySend(dbq, ref);
      for (;;) {
        drain();
        const end = mb.length;
        const j = mb.findIndex((m, i) => i >= pos && m.kind === "reply" && m.ref === ref);
        const examined = (j >= 0 ? j + 1 : end) - pos;
        out.scanned += examined;
        if (examined > 0) yield* t.work(examined * c.scanNs, "scan");
        if (j >= 0) {
          mb.splice(j, 1);
          break;
        }
        // Nothing matched up to `end`. Messages that arrived during the scan come next; if there are none, wait.
        pos = end;
        if (mb.length === pos && !t.tryRecv(notify)) yield* t.recv(notify);
      }
      out.calls++;
      out.callNs += t.now() - start;
      out.handled++;
    }
  });
  rt.run({ untilNs: c.durationNs });
  return {
    samples,
    handled: out.handled,
    finalLen: mb.length,
    scannedPerCall: out.calls ? out.scanned / out.calls : 0,
    callMeanNs: out.calls ? out.callNs / out.calls : 0,
  };
}

// ---------------------------------------------------------------- an OTP supervisor

export type Strategy = "one_for_one" | "one_for_all" | "rest_for_one";

export interface Child {
  name: string;
  /** A new pid at each start. */
  pid: number;
  /** In-memory state that a restart loses: requests served since the last start. */
  served: number;
  starts: number;
}

export interface SupConfig { strategy: Strategy; intensity: number; period: number }

/** OTP's default restart intensity: at most 1 restart in 5 seconds. */
export const SUP_DEFAULTS: SupConfig = { strategy: "one_for_one", intensity: 1, period: 5 };

export const CHILD_NAMES = ["db_pool", "cache", "http"] as const;

export interface SupEvent { t: number; text: string; tone: "plain" | "bad" | "good" | "warn" }

/**
 * A supervisor with three children, started in the order of CHILD_NAMES, under a parent supervisor. Time is in whole
 * seconds. `crash(i)` kills child i; the supervisor applies its strategy and counts one restart. When the restarts in
 * the last `period` seconds exceed `intensity`, the supervisor shuts its children down and exits; the parent restarts
 * the whole subtree, and counts that against its own intensity (the same limits). If the parent also gives up, the
 * application stops.
 */
export class Supervisor {
  t = 0;
  children: Child[];
  /** Times of restarts that this supervisor made, and that the parent made of this supervisor. */
  restarts: number[] = [];
  parentRestarts: number[] = [];
  /** The application stopped: the parent gave up too. */
  stopped = false;
  log: SupEvent[] = [];
  private pid = 100;

  constructor(readonly cfg: SupConfig = SUP_DEFAULTS) {
    this.children = CHILD_NAMES.map((name) => this.fresh(name));
    this.say(`Supervisor (${cfg.strategy}) starts ${CHILD_NAMES.join(", then ")}.`, "plain");
  }

  private fresh(name: string): Child {
    return { name, pid: this.pid++, served: 0, starts: 1 };
  }

  private say(text: string, tone: SupEvent["tone"]) {
    this.log.push({ t: this.t, text, tone });
  }

  /** Restarts kept by OTP's rule: a restart counts while now − time ≤ period. */
  inPeriod(times: number[]) {
    return times.filter((x) => this.t - x <= this.cfg.period);
  }

  /** Time passes; every live child serves one request per second. */
  tick(seconds = 1) {
    if (this.stopped) return;
    for (let s = 0; s < seconds; s++) {
      this.t++;
      for (const ch of this.children) ch.served++;
    }
  }

  crash(i: number) {
    if (this.stopped) return;
    const ch = this.children[i]!;
    this.say(`${ch.name} <${ch.pid}> crashes. Its state (${ch.served} served) is gone.`, "bad");
    const next = this.inPeriod([...this.restarts, this.t]);
    if (next.length > this.cfg.intensity) {
      this.restarts = next;
      this.escalate();
      return;
    }
    this.restarts = next;
    const n = this.children.length;
    // Which children restart: the crashed one, all of them, or it and every child started after it.
    const set = this.cfg.strategy === "one_for_one" ? [i] : this.cfg.strategy === "one_for_all" ? [...Array(n).keys()] : [...Array(n).keys()].filter((k) => k >= i);
    const others = set.filter((k) => k !== i).reverse();
    if (others.length) this.say(`${this.cfg.strategy}: terminate ${others.map((k) => this.children[k]!.name).join(", ")} (reverse start order).`, "warn");
    for (const k of set) this.children[k] = { ...this.fresh(this.children[k]!.name), starts: this.children[k]!.starts + 1 };
    this.say(`Restart ${set.map((k) => `${this.children[k]!.name} <${this.children[k]!.pid}>`).join(", then ")}. Restarts in the last ${this.cfg.period} s: ${next.length} of ${this.cfg.intensity} allowed.`, "good");
  }

  private escalate() {
    this.say(`More than ${this.cfg.intensity} restart${this.cfg.intensity === 1 ? "" : "s"} in ${this.cfg.period} s. The supervisor terminates ${[...CHILD_NAMES].reverse().join(", ")} and exits with reason shutdown.`, "bad");
    const next = this.inPeriod([...this.parentRestarts, this.t]);
    this.parentRestarts = next;
    if (next.length > this.cfg.intensity) {
      this.stopped = true;
      this.say("The parent supervisor also reaches its limit and exits. The application stops.", "bad");
      return;
    }
    this.restarts = [];
    this.children = this.children.map((c) => ({ ...this.fresh(c.name), starts: c.starts + 1 }));
    this.say(`The parent restarts the whole subtree: ${this.children.map((c) => `${c.name} <${c.pid}>`).join(", ")}.`, "warn");
  }
}

export type SupAction = { k: "crash"; i: number } | { k: "tick"; s: number };

export function replaySupervisor(cfg: SupConfig, actions: SupAction[]): Supervisor {
  const s = new Supervisor(cfg);
  for (const a of actions) {
    if (a.k === "crash") s.crash(a.i);
    else s.tick(a.s);
  }
  return s;
}
