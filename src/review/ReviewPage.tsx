import { useEffect, useState } from "react";
import { Link } from "react-router";
import { loadDeck, gradeCard, type Card } from "./deck";
import { findLesson } from "../content/curriculum";

const GRADES = [
  { q: 1, label: "Again" },
  { q: 3, label: "Hard" },
  { q: 4, label: "Good" },
  { q: 5, label: "Easy" },
];

export default function ReviewPage() {
  const [deck, setDeck] = useState<Card[] | null>(null);
  const [shown, setShown] = useState(false);

  const refresh = () => loadDeck().then((d) => setDeck(Object.values(d)));
  useEffect(() => void refresh(), []);

  if (!deck) return null;
  const now = Date.now();
  const due = deck.filter((c) => c.due <= now).sort((a, b) => a.due - b.due);
  const card = due[0];
  const upcoming = deck.filter((c) => c.due > now).length;

  const onGrade = async (q: number) => {
    if (!card) return;
    await gradeCard(card.id, q);
    setShown(false);
    await refresh();
  };

  const where = card && (() => {
    const [t, m, l] = card.path.split("/");
    return findLesson(t!, m!, l!);
  })();

  return (
    <div className="page">
      <h1>Review</h1>
      <p className="lede">
        {deck.length === 0
          ? "No cards yet. Finish a lesson's Recall section to add cards."
          : `${due.length} due · ${upcoming} scheduled later · ${deck.length} total`}
      </p>
      {card ? (
        <div className="predict" style={{ padding: 20 }}>
          {where && (
            <div className="predict-label">
              <Link to={`/${card.path}`}>{where.track.title} · {where.lesson.title}</Link>
            </div>
          )}
          <div style={{ fontSize: 17, margin: "6px 0 14px" }}>{card.q}</div>
          {shown ? (
            <>
              <div className="flash-a" style={{ fontSize: 15 }}>{card.a}</div>
              <div className="row" style={{ marginTop: 16 }}>
                {GRADES.map((g) => (
                  <button key={g.q} className="btn" onClick={() => onGrade(g.q)}>{g.label}</button>
                ))}
              </div>
            </>
          ) : (
            <button className="btn primary" onClick={() => setShown(true)}>Show answer</button>
          )}
        </div>
      ) : deck.length > 0 ? (
        <div className="empty">Nothing due. Come back tomorrow.</div>
      ) : null}
    </div>
  );
}
