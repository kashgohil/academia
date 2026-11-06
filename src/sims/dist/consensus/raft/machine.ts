/** A small key-value state machine for the Raft lessons. The capstone can bring its own StateMachine. */
import type { StateMachine } from "./types";

export type KvCmd =
  | { op: "set"; key: string; value: number }
  | { op: "add"; key: string; delta: number }
  | { op: "get"; key: string };

export class KvMachine implements StateMachine<KvCmd> {
  data = new Map<string, number>();
  /** Number of commands applied since the start (or since the restored snapshot). */
  applied = 0;

  apply(cmd: KvCmd): number | undefined {
    this.applied++;
    if (cmd.op === "set") this.data.set(cmd.key, cmd.value);
    else if (cmd.op === "add") this.data.set(cmd.key, (this.data.get(cmd.key) ?? 0) + cmd.delta);
    return this.data.get(cmd.key);
  }

  snapshot() {
    return { data: [...this.data].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), applied: this.applied };
  }

  restore(s: unknown) {
    const x = s as { data: [string, number][]; applied: number } | null;
    this.data = new Map(x?.data ?? []);
    this.applied = x?.applied ?? 0;
  }
}

/** A short label for a command: "x=3", "y+1", "get x". */
export function fmtKv(cmd: KvCmd): string {
  if (cmd.op === "set") return `${cmd.key}=${cmd.value}`;
  if (cmd.op === "add") return `${cmd.key}${cmd.delta >= 0 ? "+" : ""}${cmd.delta}`;
  return `get ${cmd.key}`;
}
