import { Children, useState, type ReactNode } from "react";
import katex from "katex";

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

/** Inline TeX for use inside TSX demos (MDX prose uses $…$ directly). */
export function Tex({ children, block }: { children: string; block?: boolean }) {
  return <span dangerouslySetInnerHTML={{ __html: katex.renderToString(children, { displayMode: block, throwOnError: false }) }} />;
}
