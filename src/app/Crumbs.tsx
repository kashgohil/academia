import { Link, useLocation } from "react-router";
import { findLesson, findTrack } from "../content/curriculum";

/** The trail for the current route. The last item is the current page and is not a link. */
function trail(pathname: string): { label: string; to?: string }[] {
  const parts = pathname.split("/").filter(Boolean);
  const home = { label: "Tracks", to: "/" };
  if (parts.length === 0) return [{ label: "Tracks" }];
  if (parts[0] === "review") return [home, { label: "Review" }];
  const track = findTrack(parts[0]!);
  if (!track) return [home, { label: "Not found" }];
  if (parts.length === 1) return [home, { label: track.title }];
  const found = findLesson(parts[0]!, parts[1] ?? "", parts[2] ?? "");
  if (!found) return [home, { label: track.title, to: `/${track.slug}` }, { label: "Not found" }];
  return [
    home,
    { label: track.title, to: `/${track.slug}` },
    { label: found.module.title, to: `/${track.slug}#${found.module.slug}` },
    { label: found.lesson.title },
  ];
}

export default function Crumbs() {
  const { pathname } = useLocation();
  const items = trail(pathname);
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) => (
          <li key={i} className={i === items.length - 1 ? "here" : undefined}>
            {c.to && i < items.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
