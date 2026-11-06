import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { TRACKS, type Track } from "../content/curriculum";
import { useDone } from "../kit/progress";
import { toggleTheme } from "./theme";

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`chev${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Tracks and modules are accordions. The track and module of the current page open by themselves.
 * Opening one track closes the others, so the list stays short.
 */
export default function Sidebar({ open, onSearch }: { open: boolean; onSearch: () => void }) {
  const { pathname } = useLocation();
  const [trackSlug, moduleSlug] = pathname.split("/").filter(Boolean);
  const done = useDone();
  const [openTrack, setOpenTrack] = useState<string | undefined>(trackSlug);
  const [openModules, setOpenModules] = useState<Set<string>>(() => new Set(moduleSlug ? [`${trackSlug}/${moduleSlug}`] : []));
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!trackSlug || trackSlug === "review") return;
    setOpenTrack(trackSlug);
    if (moduleSlug) setOpenModules((s) => (s.has(`${trackSlug}/${moduleSlug}`) ? s : new Set(s).add(`${trackSlug}/${moduleSlug}`)));
  }, [trackSlug, moduleSlug]);

  // Bring the current lesson into view inside the sidebar only. scrollIntoView would also scroll the page.
  useEffect(() => {
    const box = ref.current;
    const active = box?.querySelector<HTMLElement>(".nav-sub .nav-link.active");
    if (!box || !active) return;
    const a = active.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (a.top < b.top + 8 || a.bottom > b.bottom - 8) box.scrollTop += a.top - b.top - b.height / 3;
  }, [pathname]);

  const toggleModule = (key: string) =>
    setOpenModules((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <aside ref={ref} className={`sidebar${open ? " open" : ""}`}>
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
      {TRACKS.map((t) => (
        <TrackItem
          key={t.slug}
          track={t}
          open={openTrack === t.slug}
          onToggle={() => setOpenTrack((o) => (o === t.slug ? undefined : t.slug))}
          openModules={openModules}
          onToggleModule={toggleModule}
          done={done}
        />
      ))}
    </aside>
  );
}

function TrackItem({ track: t, open, onToggle, openModules, onToggleModule, done }: {
  track: Track;
  open: boolean;
  onToggle: () => void;
  openModules: Set<string>;
  onToggleModule: (key: string) => void;
  done: Set<string>;
}) {
  const lessons = t.modules.flatMap((m) => m.lessons);
  const live = lessons.filter((l) => l.status === "live").length;
  const id = `nav-${t.slug}`;
  return (
    <div>
      <div className="nav-row">
        <button className="nav-toggle" onClick={onToggle} aria-expanded={open} aria-controls={id} aria-label={`${open ? "Close" : "Open"} ${t.title}`}>
          <Chevron open={open} />
        </button>
        <NavLink to={`/${t.slug}`} end className="nav-link grow" onClick={() => !open && onToggle()}>
          {t.title}
          <span className="count">{live > 0 ? `${live}/` : ""}{lessons.length}</span>
        </NavLink>
      </div>
      {open && (
        <div className="nav-sub" id={id}>
          {t.modules.map((m) => {
            const key = `${t.slug}/${m.slug}`;
            const mOpen = openModules.has(key);
            const mLive = m.lessons.filter((l) => l.status === "live").length;
            return (
              <div key={m.slug}>
                <button className="nav-module" onClick={() => onToggleModule(key)} aria-expanded={mOpen} aria-controls={`nav-${key}`}>
                  <Chevron open={mOpen} />
                  <span className="grow">{m.title}</span>
                  <span className="count">{mLive > 0 ? `${mLive}/` : ""}{m.lessons.length}</span>
                </button>
                {mOpen && (
                  <div id={`nav-${key}`} className="nav-lessons">
                    {m.lessons.map((l) => (
                      <NavLink key={l.slug} to={`/${l.path}`} className={`nav-link${l.status === "planned" ? " planned" : ""}`}>
                        <span>{l.title}</span>
                        {done.has(l.path) && <span className="dot done" />}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
