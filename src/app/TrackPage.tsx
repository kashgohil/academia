import { Link, useParams } from "react-router";
import { findTrack, LEVELS, type Level } from "../content/curriculum";
import { useDone } from "../kit/progress";
import NotFound from "./NotFound";

export default function TrackPage() {
  const { track: slug = "" } = useParams();
  const track = findTrack(slug);
  const done = useDone();
  if (!track) return <NotFound />;

  const levels = ([1, 2, 3, 4] as Level[]).filter((lv) => track.modules.some((m) => m.level === lv));
  const total = track.modules.reduce((n, m) => n + m.lessons.length, 0);

  return (
    <div className="page wide">
      <div className="crumbs"><Link to="/">Tracks</Link><span>/</span></div>
      <h1>{track.title}</h1>
      <p className="lede">{track.blurb} {track.modules.length} modules, {total} lessons.</p>

      {levels.map((lv) => (
        <section key={lv}>
          <div className="level-head">
            <h2>{LEVELS[lv]}</h2>
            <span className="tag">Level {lv}</span>
          </div>
          {track.modules.filter((m) => m.level === lv).map((m) => (
            <div key={m.slug} className="module">
              <h3>{m.title}</h3>
              <ul className="lesson-list">
                {m.lessons.map((l) => (
                  <li key={l.slug}>
                    <span className={`dot ${done.has(l.path) ? "done" : l.status === "live" ? "live" : ""}`} />
                    <Link to={`/${l.path}`} className={l.status === "live" ? "live" : ""}>{l.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
