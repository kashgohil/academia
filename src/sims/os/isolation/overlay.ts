/**
 * overlayfs: a merged view of read-only lower layers and one writable upper layer.
 * A read takes the top-most layer that has the path. The first write copies the whole file up, even for one byte.
 * A delete of a lower file leaves a whiteout in the upper layer. A new directory over an old one is opaque.
 */
export type OverlayEntry =
  | { kind: "file"; size: number; content: string }
  | { kind: "dir"; opaque?: boolean }
  | { kind: "whiteout" };

export type Layer = { name: string; files: Map<string, OverlayEntry> };

export const makeLayer = (name: string, files: Record<string, { size: number; content: string }>): Layer =>
  ({ name, files: new Map(Object.entries(files).map(([p, f]) => [p, { kind: "file" as const, ...f }])) });

const parents = (path: string): string[] => {
  const out: string[] = [];
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) out.push("/" + parts.slice(0, i).join("/"));
  return out;
};

export interface ReadResult { content: string; size: number; layer: string; layersChecked: number }
export type OverlayEventKind = "read" | "copy-up" | "write" | "create" | "whiteout" | "delete" | "opaque" | "miss";
export interface OverlayEvent { kind: OverlayEventKind; path: string; bytes: number; text: string }

export class Overlay {
  /** Index 0 is the top-most lower layer, as in lowerdir=top:...:bottom. */
  readonly lower: Layer[];
  readonly upper: Layer = { name: "upper", files: new Map() };
  copyUps = 0;
  copyUpBytes = 0;
  writtenBytes = 0;
  whiteouts = 0;
  events: OverlayEvent[] = [];

  constructor(lower: Layer[]) { this.lower = lower; }

  /** Layers from the top down. */
  get stack(): Layer[] { return [this.upper, ...this.lower]; }

  /**
   * Lookup, top down. A whiteout on the path or on a parent directory ends the search with nothing.
   * An opaque parent directory stops the search at that layer.
   */
  private find(path: string): { entry: OverlayEntry; layer: Layer; checked: number } | null {
    const dirs = parents(path);
    let checked = 0;
    for (const layer of this.stack) {
      checked++;
      if (dirs.some((d) => layer.files.get(d)?.kind === "whiteout")) return null;
      const e = layer.files.get(path);
      if (e) return e.kind === "whiteout" ? null : { entry: e, layer, checked };
      const opaque = dirs.some((d) => { const x = layer.files.get(d); return x?.kind === "dir" && x.opaque; });
      if (opaque) return null;
    }
    return null;
  }

  /** The top-most layer's content, or null if the path does not exist in the merged view. */
  read(path: string): ReadResult | null {
    const f = this.find(path);
    if (!f || f.entry.kind !== "file") {
      this.events.push({ kind: "miss", path, bytes: 0, text: `${path}: ENOENT in the merged view.` });
      return null;
    }
    this.events.push({ kind: "read", path, bytes: 0, text: `Read ${path} from ${f.layer.name}, the top-most layer that has it.` });
    return { content: f.entry.content, size: f.entry.size, layer: f.layer.name, layersChecked: f.checked };
  }

  /** Writes `bytes` bytes into a file. The first write to a lower file copies all of it up. Returns the bytes copied up. */
  write(path: string, bytes: number, content: string): number {
    const f = this.find(path);
    if (!f || f.entry.kind !== "file") {
      this.upper.files.set(path, { kind: "file", size: bytes, content });
      this.writtenBytes += bytes;
      this.events.push({ kind: "create", path, bytes: 0, text: `Create ${path} in upper. It has no lower copy, so nothing is copied.` });
      return 0;
    }
    let copied = 0;
    if (f.layer !== this.upper) {
      copied = f.entry.size;
      this.copyUps++;
      this.copyUpBytes += copied;
      this.events.push({ kind: "copy-up", path, bytes: copied, text: `First write: copy all ${copied} bytes of ${path} from ${f.layer.name} up to upper.` });
    }
    const old = f.entry.size;
    this.upper.files.set(path, { kind: "file", size: Math.max(old, bytes), content });
    this.writtenBytes += bytes;
    this.events.push({ kind: "write", path, bytes, text: `Write ${bytes} bytes to the upper copy. ${f.layer.name === "upper" ? "No copy-up: the file is already in upper." : "The lower file does not change."}` });
    return copied;
  }

  /** Deletes a file. If a lower layer has the path, it leaves a whiteout. */
  remove(path: string): void {
    const inLower = this.lower.some((l) => l.files.has(path));
    this.upper.files.delete(path);
    if (inLower) {
      this.upper.files.set(path, { kind: "whiteout" });
      this.whiteouts++;
      this.events.push({ kind: "whiteout", path, bytes: 0, text: `Delete ${path}: lower layers are read-only, so upper gets a whiteout (a character device 0:0).` });
    } else {
      this.events.push({ kind: "delete", path, bytes: 0, text: `Delete ${path}: it exists only in upper, so it goes away for good.` });
    }
  }

  /** Removes a directory tree in the merged view, then makes a new empty one that hides the lower contents. */
  replaceDir(dir: string): void {
    for (const p of [...this.upper.files.keys()]) if (p.startsWith(dir + "/")) this.upper.files.delete(p);
    this.upper.files.set(dir, { kind: "dir", opaque: true });
    this.events.push({ kind: "opaque", path: dir, bytes: 0, text: `Make ${dir} opaque (trusted.overlay.opaque=y): lookups under it stop at upper.` });
  }

  /** The merged view: every file path that a read can find. */
  list(): string[] {
    const all = new Set<string>();
    for (const l of this.stack) for (const [p, e] of l.files) if (e.kind === "file") all.add(p);
    return [...all].filter((p) => this.find(p)?.entry.kind === "file").sort();
  }

  /** The layer that a read of this path would use, with no event. */
  source(path: string): string | null {
    const f = this.find(path);
    return f && f.entry.kind === "file" ? f.layer.name : null;
  }
}

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

/** A small image: three layers. Index 0 is the top. */
export const sampleImage = (): Layer[] => [
  makeLayer("app", { "/app/server": { size: 12 * MiB, content: "server v2" }, "/app/config.yaml": { size: 2048, content: "config: image" }, "/data/seed.db": { size: GiB, content: "seed data" } }),
  makeLayer("deps", { "/usr/lib/libssl.so": { size: 4 * MiB, content: "libssl 3" }, "/app/server": { size: 11 * MiB, content: "server v1" } }),
  makeLayer("base", { "/etc/passwd": { size: 1500, content: "root:x:0:0" }, "/bin/sh": { size: 900 * 1024, content: "busybox" }, "/usr/lib/libssl.so": { size: 3 * MiB, content: "libssl 1.1" } }),
];

/** Disk space for N containers of one image: the image is stored once, and each container adds its own upper layer. */
export const sharedDiskBytes = (imageBytes: number, upperBytes: number, containers: number) => imageBytes + upperBytes * containers;
