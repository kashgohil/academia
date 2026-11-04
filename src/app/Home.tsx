import { Link } from "react-router";
import { TRACKS, allLessons } from "../content/curriculum";
import { useDone } from "../kit/progress";

export default function Home() {
  const done = useDone();
  const lessons = allLessons();
  const live = lessons.filter((l) => l.status === "live");

  return (
    <div className="page wide">
      <h1>Lab</h1>
      <p className="lede">
        {TRACKS.length} tracks, {lessons.length} lessons, {live.length} written so far. Each lesson goes
        predict → play → explain → recall.
      </p>

      {live.length > 0 && (
        <>
          <h2 style={{ marginTop: 0 }}>Start here</h2>
          <ul className="lesson-list" style={{ marginBottom: 32 }}>
            {live.map((l) => (
              <li key={l.path}>
                <span className={`dot ${done.has(l.path) ? "done" : "live"}`} />
                <Link to={`/${l.path}`} className="live">{l.title}</Link>
                <span className="count">{l.track.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Tracks</h2>
      <div className="track-list">
        {TRACKS.map((t) => {
          const ls = t.modules.flatMap((m) => m.lessons);
          const d = ls.filter((l) => done.has(l.path)).length;
          return (
            <Link key={t.slug} to={`/${t.slug}`} className="track-item">
              <h3>{t.title}</h3>
              <p>{t.blurb}</p>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                <span className="count">{t.modules.length} modules · {ls.length} lessons</span>
                <span className="count">{d > 0 ? `${d} done` : ""}</span>
              </div>
              <div className="progress"><div style={{ width: `${(100 * d) / ls.length}%` }} /></div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
