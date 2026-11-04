/** User namespace ID maps: the format and the rules of /proc/<pid>/uid_map. */
export interface MapLine { inside: number; outside: number; length: number }

/** Since Linux 4.15 a map can have this many lines. Before that the limit was 5. */
export const UID_MAP_MAX_EXTENTS = 340;
/** /proc/sys/kernel/overflowuid: what a process sees for an ID with no mapping. */
export const OVERFLOW_UID = 65534;
export const MAX_USER_NS_LEVEL = 32;
export const NO_ID = 4294967295;

/** The kernel's checks in map_write. It returns null, or the reason for EINVAL. */
export function validateMap(lines: readonly MapLine[]): string | null {
  if (lines.length === 0) return "A map must have at least one line.";
  if (lines.length > UID_MAP_MAX_EXTENTS) return `A map can have at most ${UID_MAP_MAX_EXTENTS} lines.`;
  const over = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.length <= 0) return "A range must have a length above 0.";
    if (l.inside + l.length > NO_ID || l.outside + l.length > NO_ID) return "A range must not wrap past the top of the ID space.";
    for (let j = 0; j < i; j++) {
      const m = lines[j]!;
      if (over(l.inside, l.inside + l.length, m.inside, m.inside + m.length)) return "Two ranges overlap on the inside.";
      if (over(l.outside, l.outside + l.length, m.outside, m.outside + m.length)) return "Two ranges overlap on the outside.";
    }
  }
  return null;
}

/** Inside ID to the ID in the parent namespace, or null if there is no mapping. */
export function toOutside(lines: readonly MapLine[], inside: number): number | null {
  for (const l of lines) if (inside >= l.inside && inside < l.inside + l.length) return l.outside + (inside - l.inside);
  return null;
}

/** Parent ID to the inside ID, or null if there is no mapping. */
export function toInside(lines: readonly MapLine[], outside: number): number | null {
  for (const l of lines) if (outside >= l.outside && outside < l.outside + l.length) return l.inside + (outside - l.outside);
  return null;
}

/** What `ls -l` or stat shows inside the namespace for a file owned by this outside ID. */
export const displayedInside = (lines: readonly MapLine[], outside: number) => toInside(lines, outside) ?? OVERFLOW_UID;

/** Maps from the innermost namespace out to the host. The result is the host ID, or null if any level has no mapping. */
export function toHostNested(chain: readonly (readonly MapLine[])[], id: number): number | null {
  let cur: number | null = id;
  for (const m of chain) { if (cur === null) return null; cur = toOutside(m, cur); }
  return cur;
}
export function fromHostNested(chain: readonly (readonly MapLine[])[], host: number): number | null {
  let cur: number | null = host;
  for (let i = chain.length - 1; i >= 0; i--) { if (cur === null) return null; cur = toInside(chain[i]!, cur); }
  return cur;
}

/** Parses the text of uid_map. */
export function parseMap(text: string): MapLine[] {
  return text.trim().split("\n").filter(Boolean).map((row) => {
    const [a, b, c] = row.trim().split(/\s+/).map(Number);
    return { inside: a!, outside: b!, length: c! };
  });
}
export const formatMap = (lines: readonly MapLine[]) => lines.map((l) => `${l.inside} ${l.outside} ${l.length}`).join("\n");

/** Who may write the map. A writer with no CAP_SETUID in the parent namespace may map only its own effective UID, in one line of length 1. */
export function mayWriteMap(lines: readonly MapLine[], writerEuid: number, hasCapSetuidInParent: boolean): boolean {
  if (hasCapSetuidInParent) return true;
  return lines.length === 1 && lines[0]!.length === 1 && lines[0]!.outside === writerEuid;
}

export const MAP_PRESETS: { id: string; label: string; lines: MapLine[]; note: string }[] = [
  { id: "self", label: "Only my UID", lines: [{ inside: 0, outside: 1000, length: 1 }], note: "An unprivileged process can write this map with no helper." },
  { id: "rootless", label: "Rootless", lines: [{ inside: 0, outside: 1000, length: 1 }, { inside: 1, outside: 100000, length: 65536 }], note: "newuidmap, a setuid helper, writes this map after it checks /etc/subuid." },
  { id: "remap", label: "userns-remap", lines: [{ inside: 0, outside: 100000, length: 65536 }], note: "Root in the container is an ordinary UID on the host." },
  { id: "identity", label: "No remap", lines: [{ inside: 0, outside: 0, length: 4294967295 }], note: "This is the initial user namespace. Root inside is root on the host." },
];
