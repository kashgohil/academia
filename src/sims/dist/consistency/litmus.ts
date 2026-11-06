/**
 * Litmus histories: small histories that one model allows and a stronger model forbids. Each one lists the verdict
 * that the checkers must give, and the tests pin them.
 */
import { mk, type HOp } from "./history";
import type { ModelName } from "./models";

export interface Litmus {
  id: string;
  name: string;
  /** One sentence: what happens. */
  story: string;
  history: HOp[];
  clients: number;
  expect: Record<ModelName, boolean>;
}

const L = (id: string, name: string, story: string, clients: number, h: HOp[], e: [boolean, boolean, boolean, boolean]): Litmus => ({
  id, name, story, history: h, clients, expect: { linearizable: e[0], sequential: e[1], causal: e[2], eventual: e[3] },
});

export const LITMUS: Litmus[] = [
  L("overlap", "Read during a write", "C2 reads during the write and gets the old value; C3 reads later in the write and gets the new value.", 3,
    mk([[0, "w", "x", 1, 0, 40], [1, "r", "x", 0, 5, 15], [2, "r", "x", 1, 20, 35]]), [true, true, true, true]),
  L("stale", "Stale read", "The write returns. Later, C2 still reads the old value.", 2,
    mk([[0, "w", "x", 1, 0, 10], [1, "r", "x", 0, 20, 30]]), [false, true, true, true]),
  L("inversion", "New, then old", "During a write, C2 reads the new value. After that read returns, C3 reads the old value.", 3,
    mk([[0, "w", "x", 1, 0, 50], [1, "r", "x", 1, 5, 15], [2, "r", "x", 0, 25, 40]]), [false, true, true, true]),
  L("own", "Own write lost", "C1 writes, then reads its own register and gets the old value.", 1,
    mk([[0, "w", "x", 1, 0, 10], [0, "r", "x", 0, 15, 25]]), [false, false, false, true]),
  L("monotonic", "Time goes back", "C2 reads the new value, then the old value.", 2,
    mk([[0, "w", "x", 1, 0, 10], [1, "r", "x", 1, 15, 20], [1, "r", "x", 0, 25, 30]]), [false, false, false, true]),
  L("reply", "Reply before question", "C2 reads the question q and writes a reply a. C3 sees the reply but not the question.", 3,
    mk([[0, "w", "q", 1, 0, 10], [1, "r", "q", 1, 15, 20], [1, "w", "a", 1, 25, 30], [2, "r", "a", 1, 35, 40], [2, "r", "q", 0, 45, 50]]), [false, false, false, true]),
  L("sb", "Store buffering", "Each client writes its own register, then reads the other one and gets 0.", 2,
    mk([[0, "w", "x", 1, 0, 10], [1, "w", "y", 1, 0, 10], [0, "r", "y", 0, 15, 20], [1, "r", "x", 0, 15, 20]]), [false, false, true, true]),
  L("iriw", "Two readers disagree", "Two independent writes. C3 sees x first, and C4 sees y first.", 4,
    mk([[0, "w", "x", 1, 0, 10], [1, "w", "y", 1, 0, 10], [2, "r", "x", 1, 15, 20], [2, "r", "y", 0, 25, 30], [3, "r", "y", 1, 15, 20], [3, "r", "x", 0, 25, 30]]), [false, false, true, true]),
  L("diverge", "Concurrent writes, two orders", "Two writes to x at the same time. C3 sees 1 then 2, and C4 sees 2 then 1.", 4,
    mk([[0, "w", "x", 1, 0, 10], [1, "w", "x", 2, 0, 10], [2, "r", "x", 1, 15, 20], [2, "r", "x", 2, 25, 30], [3, "r", "x", 2, 15, 20], [3, "r", "x", 1, 25, 30]]), [false, false, true, true]),
  L("thin", "Value from nowhere", "C2 reads 7, but nobody wrote 7.", 2,
    mk([[0, "w", "x", 1, 0, 10], [1, "r", "x", 7, 15, 20]]), [false, false, false, false]),
];

/** Starting histories for the history editor (lesson: linearizability). One register, three clients. */
export const EDITOR_PRESETS: { id: string; name: string; history: HOp[] }[] = [
  { id: "inversion", name: "New, then old", history: mk([[0, "w", "x", 1, 5, 60], [1, "r", "x", 1, 12, 28], [2, "r", "x", 0, 36, 52], [0, "w", "x", 2, 70, 88], [1, "r", "x", 2, 76, 95]]) },
  { id: "stale", name: "Stale read", history: mk([[0, "w", "x", 1, 5, 25], [1, "r", "x", 0, 35, 50], [2, "r", "x", 1, 55, 70], [0, "w", "x", 2, 60, 85]]) },
  { id: "race", name: "Two writers", history: mk([[0, "w", "x", 1, 5, 50], [1, "w", "x", 2, 10, 40], [2, "r", "x", 2, 45, 60], [2, "r", "x", 1, 66, 80], [1, "r", "x", 1, 70, 92]]) },
];
