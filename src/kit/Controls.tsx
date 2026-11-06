import { rich } from "./Prose";
import type { RangeSpec, Schema, Spec, Values } from "./useParams";

const RES = 1000;
const toSlider = (s: RangeSpec, v: number) =>
  s.log ? (Math.log(v / s.min) / Math.log(s.max / s.min)) * RES : v;
const fromSlider = (s: RangeSpec, x: number) => {
  if (!s.log) return x;
  const v = s.min * Math.pow(s.max / s.min, x / RES);
  return Number(v.toPrecision(3));
};

export function Param({ spec, value, onChange }: { spec: Spec; value: unknown; onChange: (v: unknown) => void }) {
  if (spec.kind === "range") {
    const v = value as number;
    return (
      <label className="param">
        <span className="param-label">
          {rich(spec.label)}
          <span className="param-value">{spec.format ? spec.format(v) : v}</span>
        </span>
        <input
          type="range"
          min={spec.log ? 0 : spec.min}
          max={spec.log ? RES : spec.max}
          step={spec.log ? 1 : (spec.step ?? (spec.max - spec.min) / 100)}
          value={toSlider(spec, v)}
          onChange={(e) => onChange(fromSlider(spec, Number(e.target.value)))}
        />
      </label>
    );
  }
  if (spec.kind === "select") {
    if (spec.segmented) {
      return (
        <div className="param">
          <span className="param-label">{rich(spec.label)}</span>
          <div className="seg">
            {spec.options.map((o) => (
              <button key={o.value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
                {rich(o.label)}
              </button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <label className="param">
        <span className="param-label">{rich(spec.label)}</span>
        <select value={value as string} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="param" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <input type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} />
      <span>{rich(spec.label)}</span>
    </label>
  );
}

/** Renders every parameter in a schema. Pass `only` to render a subset. */
export function Controls<S extends Schema>({
  params,
  only,
}: {
  params: { schema: S; values: Values<S>; set: <K extends keyof S>(k: K, v: Values<S>[K]) => void };
  only?: (keyof S)[];
}) {
  const keys = (only ?? Object.keys(params.schema)) as (keyof S & string)[];
  return (
    <>
      {keys.map((k) => (
        <Param
          key={k}
          spec={params.schema[k]!}
          value={params.values[k]}
          onChange={(v) => params.set(k, v as Values<S>[typeof k])}
        />
      ))}
    </>
  );
}
