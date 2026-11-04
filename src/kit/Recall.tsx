import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useLesson } from "./LessonContext";
import { registerCards } from "../review/deck";

export interface CardDef { q: string; a: string }

/** End-of-lesson recall. Cards are added to the spaced-repetition deck on first view. */
export function Recall({ cards }: { cards: CardDef[] }) {
  const { path } = useLesson();
  const [open, setOpen] = useState<Set<number>>(new Set());
  useEffect(() => {
    void registerCards(path, cards);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- cards are a literal in MDX

  return (
    <div className="recall">
      <h2>Recall</h2>
      <p className="muted">Answer in your head, then click to check. These cards are now in your <Link to="/review" style={{ textDecoration: "underline" }}>review queue</Link>.</p>
      {cards.map((c, i) => (
        <div key={i} className="flash" onClick={() => setOpen((s) => new Set(s).add(i))}>
          <div>{c.q}</div>
          {open.has(i) && <div className="flash-a">{c.a}</div>}
        </div>
      ))}
    </div>
  );
}
