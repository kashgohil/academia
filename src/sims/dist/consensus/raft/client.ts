/**
 * A Raft client on its own network node (dissertation section 6.3). It sends one command at a time to the node it
 * thinks leads, follows leader hints, and retries after a timeout. With `session`, each command carries
 * (client id, seq), and the state machine applies a retried command only once. Without it, a retry after a lost
 * reply applies the command twice.
 */
import type { Message } from "../../net";
import type { NodeId, RaftMsg } from "./types";
import type { RaftCluster } from "./raft";

export interface ClientResult<C> {
  seq: number;
  cmd: C;
  result: unknown;
  start: number;
  end: number;
  /** Sends, including the first. */
  tries: number;
}

export class RaftClient<C> {
  seq = 0;
  leaderGuess: NodeId = 0;
  readonly done: ClientResult<C>[] = [];
  private queue: C[] = [];
  private cur: { seq: number; cmd: C; start: number; tries: number } | null = null;

  constructor(
    private cluster: RaftCluster<C>,
    readonly node: NodeId,
    readonly opts: { timeout: number; session: boolean; retryDelay?: number },
  ) {
    cluster.clients.set(node, this);
  }

  get busy() {
    return this.cur !== null || this.queue.length > 0;
  }

  submit(cmd: C) {
    this.queue.push(cmd);
    if (!this.cur) this.next();
  }

  private next() {
    const cmd = this.queue.shift();
    if (cmd === undefined) return;
    this.cur = { seq: ++this.seq, cmd, start: this.cluster.now, tries: 0 };
    this.send();
  }

  private send() {
    const c = this.cur!;
    c.tries++;
    this.cluster.net.send(this.node, this.leaderGuess, { type: "ClientRequest", client: this.node, seq: c.seq, cmd: c.cmd, session: this.opts.session });
    this.cluster.net.setTimer(this.node, this.opts.timeout, `client:${c.seq}:${c.tries}`);
  }

  onMessage(msg: Message<RaftMsg<C>>) {
    const m = msg.payload;
    const c = this.cur;
    if (m.type !== "ClientReply" || !c || m.seq !== c.seq) return;
    if (m.ok) {
      this.done.push({ seq: c.seq, cmd: c.cmd, result: m.result, start: c.start, end: this.cluster.now, tries: c.tries });
      this.cur = null;
      this.next();
      return;
    }
    // Not the leader. Follow the hint at once, or try the next server after a pause.
    if (m.leaderHint !== null && m.leaderHint !== msg.from) {
      this.leaderGuess = m.leaderHint;
      this.send();
    } else {
      this.leaderGuess = (this.leaderGuess + 1) % this.cluster.n;
      this.cluster.net.setTimer(this.node, this.opts.retryDelay ?? 20, `client:${c.seq}:${c.tries}:retry`);
    }
  }

  onTimer(tag: string) {
    const [, seq, tries, retry] = tag.split(":");
    const c = this.cur;
    if (!c || Number(seq) !== c.seq || Number(tries) !== c.tries) return;
    if (!retry) this.leaderGuess = (this.leaderGuess + 1) % this.cluster.n; // no answer: maybe the leader is gone
    this.send();
  }
}
