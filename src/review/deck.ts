import { load, save } from "../kit/store";
import { fresh, grade, type Sched } from "./sm2";

export interface Card extends Sched { id: string; path: string; q: string; a: string }

const KEY = "review:deck";

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export const loadDeck = () => load<Record<string, Card>>(KEY, {});

/**
 * Makes the deck hold exactly the lesson's current cards. A new card is added. A card whose answer changed gets the
 * new text. A card that the lesson no longer has is removed, but if a new card has the same answer (a reworded
 * question), the new card keeps the old schedule.
 */
export async function registerCards(path: string, cards: { q: string; a: string }[]) {
  const deck = await loadDeck();
  const ids = new Set(cards.map((c) => `${path}#${hash(c.q)}`));
  const stale = Object.values(deck).filter((c) => c.path === path && !ids.has(c.id));
  let changed = false;
  for (const c of cards) {
    const id = `${path}#${hash(c.q)}`;
    const prev = deck[id];
    if (!prev) {
      const reworded = stale.find((s) => s.a === c.a);
      const sched = reworded ? { ef: reworded.ef, interval: reworded.interval, reps: reworded.reps, due: reworded.due } : fresh(Date.now());
      deck[id] = { id, path, q: c.q, a: c.a, ...sched };
      changed = true;
    } else if (prev.a !== c.a) {
      deck[id] = { ...prev, a: c.a };
      changed = true;
    }
  }
  for (const s of stale) {
    delete deck[s.id];
    changed = true;
  }
  if (changed) await save(KEY, deck);
}

export async function gradeCard(id: string, q: number) {
  const deck = await loadDeck();
  const c = deck[id];
  if (!c) return;
  deck[id] = { ...c, ...grade(c, q, Date.now()) };
  await save(KEY, deck);
}
