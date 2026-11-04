import { useEffect, useRef, useState } from "react";

export interface RangeSpec {
  kind: "range";
  label: string;
  min: number;
  max: number;
  step?: number;
  default: number;
  /** Logarithmic slider (min must be > 0). */
  log?: boolean;
  format?: (v: number) => string;
}
export interface SelectSpec<T extends string = string> {
  kind: "select";
  label: string;
  options: readonly { value: T; label: string }[];
  default: T;
  /** Render as a segmented control instead of a dropdown. */
  segmented?: boolean;
}
export interface ToggleSpec {
  kind: "toggle";
  label: string;
  default: boolean;
}
export type Spec = RangeSpec | SelectSpec<string> | ToggleSpec;
export type Schema = Record<string, Spec>;

export type Values<S extends Schema> = {
  [K in keyof S]: S[K] extends RangeSpec ? number : S[K] extends SelectSpec<infer T> ? T : boolean;
};

export const range = (s: Omit<RangeSpec, "kind">): RangeSpec => ({ kind: "range", ...s });
export const select = <T extends string>(s: Omit<SelectSpec<T>, "kind">): SelectSpec<T> => ({ kind: "select", ...s });
export const toggle = (s: Omit<ToggleSpec, "kind">): ToggleSpec => ({ kind: "toggle", ...s });

function parse(spec: Spec, raw: string | null): unknown {
  if (raw == null) return spec.default;
  switch (spec.kind) {
    case "range": {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : spec.default;
    }
    case "select":
      return spec.options.some((o) => o.value === raw) ? raw : spec.default;
    case "toggle":
      return raw === "1";
  }
}

function serialize(v: unknown): string {
  return typeof v === "boolean" ? (v ? "1" : "0") : String(v);
}

/**
 * Typed demo parameters, mirrored into the URL (`?<id>.<key>=value`) so any
 * demo state is a shareable link. Only non-default values are written.
 */
export function useParams<S extends Schema>(id: string, schema: S) {
  const [values, setValues] = useState<Values<S>>(() => {
    const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
    return Object.fromEntries(
      Object.entries(schema).map(([k, spec]) => [k, parse(spec, q.get(`${id}.${k}`))]),
    ) as Values<S>;
  });

  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const url = new URL(location.href);
      for (const [k, spec] of Object.entries(schema)) {
        const v = values[k as keyof S];
        if (v === spec.default) url.searchParams.delete(`${id}.${k}`);
        else url.searchParams.set(`${id}.${k}`, serialize(v));
      }
      history.replaceState(history.state, "", url);
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [values, id, schema]);

  const set = <K extends keyof S>(k: K, v: Values<S>[K]) => setValues((p) => ({ ...p, [k]: v }));
  const reset = () =>
    setValues(Object.fromEntries(Object.entries(schema).map(([k, s]) => [k, s.default])) as Values<S>);

  return { values, set, reset, schema };
}
