import type { ReactNode } from "react";
import { rich } from "./Prose";

/** Frame for an interactive demo: title bar, body, controls strip. */
export function Demo({ title, actions, controls, children }: { title: string; actions?: ReactNode; controls?: ReactNode; children: ReactNode }) {
  return (
    <figure className="demo" style={{ margin: "24px 0" }}>
      <div className="demo-head">
        <span className="demo-title">{title}</span>
        {actions && <div className="row">{actions}</div>}
      </div>
      <div className="demo-body">{children}</div>
      {controls && <div className="demo-controls">{controls}</div>}
    </figure>
  );
}

export function SimButtons({ sim }: { sim: { running: boolean; toggle: () => void; step: () => void; reset: () => void } }) {
  return (
    <>
      <button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button>
      <button className="btn" onClick={sim.step} disabled={sim.running}>Step</button>
      <button className="btn ghost" onClick={sim.reset}>Reset</button>
    </>
  );
}

export function Stats({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className="stats">
      {items.map((i) => (
        <div key={i.label}>
          <b>{rich(i.value)}</b>
          {rich(i.label)}
        </div>
      ))}
    </div>
  );
}
