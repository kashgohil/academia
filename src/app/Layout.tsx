import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import Sidebar from "./Sidebar";
import Search from "./Search";
import Crumbs from "./Crumbs";

export default function Layout() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const { pathname, hash } = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setNavOpen(false);
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);

  return (
    <div className="shell">
      <Sidebar open={navOpen} onSearch={() => setSearchOpen(true)} />
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
      <div className="main-col">
        <header className="topbar">
          <button className="btn menu-btn" onClick={() => setNavOpen((o) => !o)} aria-expanded={navOpen} aria-label="Open the menu">
            Menu
          </button>
          <Crumbs />
        </header>
        <main className="main">
          <Outlet />
        </main>
      </div>
      {searchOpen && <Search onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
