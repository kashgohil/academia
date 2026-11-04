/**
 * The LSM engine (lsm/LsmTree) behind the same transactional key-value interface as TinyKv.
 *
 * A transaction buffers its writes in a write batch and reads at an LSM snapshot (a sequence
 * number). Commit checks each written key for a newer version than the snapshot (optimistic
 * concurrency, as RocksDB's OptimisticTransactionDB), then applies the batch: WAL append and
 * memtable insert. Group commit shares one WAL fsync between `groupCommit` commits.
 */
import { LsmTree, type LsmOptions } from "../lsm/engine";
import { ConflictError } from "./kv";

/** The interface that both engines implement. */
export interface KvLike {
  begin(readOnly?: boolean): number;
  get(txn: number | null, key: string): string | undefined;
  put(txn: number, key: string, value: string): void;
  del(txn: number, key: string): void;
  commit(txn: number): { durable: boolean; ts: number };
  abort(txn: number): void;
}

interface LTxn { snap: number; readOnly: boolean; writes: Map<string, string | null> }

export class LsmKv implements KvLike {
  readonly lsm: LsmTree;
  private txns = new Map<number, LTxn>();
  private next = 1;
  private pending = 0;
  stats = { commits: 0, aborts: 0, conflicts: 0, walFsyncs: 0 };

  constructor(opts: Partial<LsmOptions> = {}, readonly groupCommit = 1) {
    this.lsm = new LsmTree(opts);
  }

  begin(readOnly = false): number {
    const id = this.next++;
    this.txns.set(id, { snap: this.lsm.snapshot(), readOnly, writes: new Map() });
    return id;
  }

  private tx(id: number) { const t = this.txns.get(id); if (!t) throw new Error(`T${id} is not running`); return t; }

  get(txn: number | null, key: string): string | undefined {
    if (txn === null) return this.lsm.get(key).value;
    const t = this.tx(txn);
    if (t.writes.has(key)) return t.writes.get(key) ?? undefined;
    return this.lsm.get(key, t.snap).value;
  }

  put(txn: number, key: string, value: string) { this.tx(txn).writes.set(key, value); }
  del(txn: number, key: string) { this.tx(txn).writes.set(key, null); }

  commit(txn: number): { durable: boolean; ts: number } {
    const t = this.tx(txn);
    this.txns.delete(txn);
    this.lsm.release(t.snap);
    if (!t.writes.size) return { durable: true, ts: 0 };
    // Conflict check: the newest version of each key must not be newer than the snapshot.
    // RocksDB checks the memtable history; this model looks the key up and does not count the reads.
    const g = this.lsm.stats.gets, io = this.lsm.stats.getIos;
    for (const k of t.writes.keys()) {
      const e = this.lsm.get(k).entry;
      if (e && e.seq > t.snap) {
        this.lsm.stats.gets = g; this.lsm.stats.getIos = io;
        this.stats.conflicts++;
        this.stats.aborts++;
        throw new ConflictError(txn, k, `${k} has a version newer than the snapshot`);
      }
    }
    this.lsm.stats.gets = g; this.lsm.stats.getIos = io;
    for (const [k, v] of t.writes) { if (v === null) this.lsm.del(k); else this.lsm.put(k, v); }
    this.stats.commits++;
    this.pending++;
    let durable = false;
    if (this.pending >= this.groupCommit) { this.stats.walFsyncs++; this.pending = 0; durable = true; }
    return { durable, ts: this.lsm.seq };
  }

  abort(txn: number) {
    const t = this.tx(txn);
    this.txns.delete(txn);
    this.lsm.release(t.snap);
    this.stats.aborts++;
  }

  /** Every live key and value (for tests). */
  scanAll(): Map<string, string> {
    return new Map(this.lsm.scan("", "￿").rows);
  }
}
