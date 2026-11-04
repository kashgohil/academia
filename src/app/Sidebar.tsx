import { NavLink, useParams } from "react-router";
import { TRACKS } from "../content/curriculum";
import { useDone } from "../kit/progress";
import { toggleTheme } from "./theme";

export default function Sidebar({ open, onSearch }: { open: boolean; onSearch: () => void }) {
  const { track: current } = useParams();
  const done = useDone();

  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="sidebar-head">
        <NavLink to="/" className="brand">Lab</NavLink>
        <button className="btn ghost" onClick={toggleTheme} aria-label="Toggle theme" style={{ padding: "2px 8px" }}>
          Theme
        </button>
      </div>
      <div className="sidebar-nav">
        <button className="nav-link" style={{ border: 0, background: "none", cursor: "pointer", textAlign: "left" }} onClick={onSearch}>
          Search <span className="kbd">/</span>
        </button>
        <NavLink to="/" end className="nav-link">All tracks</NavLink>
        <NavLink to="/review" className="nav-link">Review</NavLink>
      </div>
      <div className="nav-section">Tracks</div>
      {TRACKS.map((t) => {
        const lessons = t.modules.flatMap((m) => m.lessons);
        const live = lessons.filter((l) => l.status === "live").length;
        return (
          <div key={t.slug}>
            <NavLink to={`/${t.slug}`} className="nav-link">
              {t.title}
              <span className="count">{live > 0 ? `${live}/` : ""}{lessons.length}</span>
            </NavLink>
            {current === t.slug && (
              <div className="nav-sub">
                {t.modules.map((m) => (
                  <div key={m.slug}>
                    <div className="nav-module">{m.title}</div>
                    {m.lessons.map((l) => (
                      <NavLink
                        key={l.slug}
                        to={`/${l.path}`}
                        className="nav-link"
                        style={l.status === "planned" ? { color: "var(--faint)" } : undefined}
                      >
                        <span>{l.title}</span>
                        {done.has(l.path) && <span className="dot done" />}
                      </NavLink>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
