import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { allLessons, TRACKS } from "../content/curriculum";

interface Hit { title: string; where: string; to: string; live: boolean }

const INDEX: Hit[] = [
  ...TRACKS.map((t) => ({ title: t.title, where: "Track", to: `/${t.slug}`, live: true })),
  ...allLessons().map((l) => ({
    title: l.title,
    where: `${l.track.title} · ${l.module.title}`,
    to: `/${l.path}`,
    live: l.status === "live",
  })),
];

export default function Search({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const nav = useNavigate();

  const hits = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return INDEX.filter((h) => h.live).slice(0, 12);
    return INDEX.filter((h) => {
      const s = `${h.title} ${h.where}`.toLowerCase();
      return terms.every((t) => s.includes(t));
    })
      .sort((a, b) => Number(b.live) - Number(a.live))
      .slice(0, 30);
  }, [q]);

  const go = (h?: Hit) => {
    if (!h) return;
    nav(h.to);
    onClose();
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="search" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Search tracks and lessons"
          value={q}
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(hits.length - 1, s + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            else if (e.key === "Enter") go(hits[sel]);
          }}
        />
        <ul>
          {hits.map((h, i) => (
            <li key={h.to} className={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)}>
              <Link to={h.to} onClick={onClose} style={h.live ? undefined : { color: "var(--muted)" }}>
                <span>{h.title}</span>
                <span className="where">{h.where}</span>
              </Link>
            </li>
          ))}
          {hits.length === 0 && <li className="muted" style={{ padding: "8px 10px" }}>No matches</li>}
        </ul>
      </div>
    </div>
  );
}
