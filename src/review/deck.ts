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

/** Adds cards not yet in the deck; existing cards keep their schedule but get updated text. */
export async function registerCards(path: string, cards: { q: string; a: string }[]) {
  const deck = await loadDeck();
  let changed = false;
  for (const c of cards) {
    const id = `${path}#${hash(c.q)}`;
    const prev = deck[id];
    if (!prev) {
      deck[id] = { id, path, q: c.q, a: c.a, ...fresh(Date.now()) };
      changed = true;
    } else if (prev.a !== c.a) {
      deck[id] = { ...prev, a: c.a };
      changed = true;
    }
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
