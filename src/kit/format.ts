const PREFIXES: [number, string][] = [
  [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"],
];

/** 4700 → "4.7 k", 0.0000022 → "2.2 µ". */
export function si(v: number, unit = "", digits = 3): string {
  if (v === 0) return `0 ${unit}`.trim();
  const a = Math.abs(v);
  const [f, p] = PREFIXES.find(([f]) => a >= f * 0.9995) ?? PREFIXES[PREFIXES.length - 1]!;
  return `${Number((v / f).toPrecision(digits))} ${p}${unit}`.trim();
}

export function bytes(v: number): string {
  if (v >= 1 << 30) return `${+(v / (1 << 30)).toPrecision(3)} GiB`;
  if (v >= 1 << 20) return `${+(v / (1 << 20)).toPrecision(3)} MiB`;
  if (v >= 1024) return `${+(v / 1024).toPrecision(3)} KiB`;
  return `${v} B`;
}

export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

/** Thousands separators: 1234567.8 → "1,234,568". */
export const int = (v: number) => Math.round(v).toLocaleString("en-US");

/** A fixed number of decimals: fixed(3.14159) → "3.14". "–" if not finite. */
export const fixed = (v: number, decimals = 2) => (Number.isFinite(v) ? v.toFixed(decimals) : "–");

/** A fixed number of significant digits, with separators: sig(1234.5) → "1,230". "–" if not finite. */
export const sig = (v: number, digits = 3) => (Number.isFinite(v) ? Number(v.toPrecision(digits)).toLocaleString("en-US") : "–");

/** Milliseconds: ms(0.25) → "250 µs", ms(12.3) → "12.30 ms", ms(1234) → "1,230 ms". */
export const ms = (v: number) => (v >= 100 ? `${sig(v, 3)} ms` : v >= 1 ? `${v.toFixed(2)} ms` : `${(v * 1000).toFixed(0)} µs`);
