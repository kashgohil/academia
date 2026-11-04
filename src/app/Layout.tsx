import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import Sidebar from "./Sidebar";
import Search from "./Search";

export default function Layout() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setNavOpen(false);
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="shell">
      <button className="btn menu-btn" onClick={() => setNavOpen((o) => !o)}>Menu</button>
      <Sidebar open={navOpen} onSearch={() => setSearchOpen(true)} />
      <main className="main">
        <Outlet />
      </main>
      {searchOpen && <Search onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
