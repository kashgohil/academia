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
