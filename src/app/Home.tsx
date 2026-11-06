import { Link } from "react-router";
import { TRACKS, allLessons } from "../content/curriculum";
import { useDone } from "../kit/progress";

export default function Home() {
  const done = useDone();
  const lessons = allLessons();
  const live = lessons.filter((l) => l.status === "live");
  // One entry per track that has written lessons: its first written lesson, in curriculum order.
  const started = TRACKS.flatMap((track) => {
    const all = track.modules.flatMap((m) => m.lessons);
    const written = all.filter((l) => l.status === "live");
    return written.length ? [{ track, first: written[0]!, written: written.length, total: all.length }] : [];
  });

  return (
    <div className="page wide">
      <h1>Lab</h1>
      <p className="lede">
        {TRACKS.length} tracks, {lessons.length} lessons, {live.length} written so far. Each lesson goes
        predict → play → explain → recall.
      </p>

      {started.length > 0 && (
        <>
          <h2 style={{ marginTop: 0 }}>Start here</h2>
          <ul className="start-list">
            {started.map(({ track: t, first, written, total }) => (
              <li key={t.slug}>
                <Link to={`/${first.path}`}>
                  <b>{t.title}</b>
                  <span>{written} of {total} lessons written · begins with {first.title}</span>
                </Link>
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
