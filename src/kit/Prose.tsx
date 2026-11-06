import { Children, useEffect, useState, type ReactNode } from "react";

export function Callout({ title, kind = "note", children }: { title?: string; kind?: "note" | "warn"; children: ReactNode }) {
  return (
    <div className={`callout${kind === "warn" ? " warn" : ""}`}>
      {title && <div className="callout-title">{title}</div>}
      {children}
    </div>
  );
}

/** Reveal a derivation one step at a time. Each child is a step. */
export function Steps({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  const [n, setN] = useState(1);
  return (
    <div className="steps">
      {items.slice(0, n).map((c, i) => <div key={i} className="step">{c}</div>)}
      <div className="row" style={{ marginTop: 8 }}>
        {n < items.length ? (
          <button className="btn" onClick={() => setN(n + 1)}>Next step ({n}/{items.length})</button>
        ) : (
          <button className="btn ghost" onClick={() => setN(1)}>Collapse</button>
        )}
      </div>
    </div>
  );
}

type Katex = typeof import("katex").default;
let katexP: Promise<Katex> | null = null;

/** Inline TeX for use inside TSX demos and JSX props (MDX prose uses $…$ directly). KaTeX loads lazily. */
export function Tex({ children, block }: { children: string; block?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    katexP ??= import("katex").then((m) => m.default);
    let live = true;
    void katexP.then((k) => live && setHtml(k.renderToString(children, { displayMode: block, throwOnError: false })));
    return () => { live = false; };
  }, [children, block]);
  return html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : <span className="tex-pending">{children}</span>;
}

/**
 * Plain text that may hold inline math between dollar signs, for JSX props and demo labels:
 * "About $(1 - e^{-kn/m})^k$". Write a literal dollar sign as \$. MDX prose uses $…$ directly.
 */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/(?<!\\)\$([^$]+?)(?<!\\)\$/);
  if (parts.length === 1) return <>{text.replaceAll("\\$", "$")}</>;
  return <>{parts.map((p, i) => (i % 2 ? <Tex key={i}>{p}</Tex> : p.replaceAll("\\$", "$")))}</>;
}

/** Renders a string through Rich, and passes any other node through. */
export const rich = (v: ReactNode) => (typeof v === "string" ? <Rich text={v} /> : v);
