import { Controls, useParams, select, toggle } from "../kit";
import { REGION, type Heap } from "../wasm/heapsim";

const { live: L, free: F, meta: M, pad: P, slack: S, dead: D } = REGION;
import { HeapPlayground, type Scenario } from "./heap/HeapPlayground";

const hex = (n: number | null) => (n === null ? "null" : "0x" + n.toString(16).padStart(4, "0"));

// ---------------- Bump ----------------

const fields = (h: Heap, spec: [string, number, number][]) =>
  spec.map(([name, size, align]) => `${name}: alloc(${size}, align ${align}) → ${hex(h.alloc(size, align))}`);

export function BumpDemo() {
  const scenarios: Scenario[] = [
    { label: "char, double, char, double", run: (h) => [...fields(h, [["a", 1, 1], ["b", 8, 8], ["c", 1, 1], ["d", 8, 8]]), `${h.stats().pad} B of padding`] },
    { label: "double, double, char, char", run: (h) => [...fields(h, [["b", 8, 8], ["d", 8, 8], ["a", 1, 1], ["c", 1, 1]]), `${h.stats().pad} B of padding`] },
  ];
  return <HeapPlayground title="Bump allocator · 1 KiB" config={{ kind: "bump", cap: 1024 }} kinds={[L, F, P, D]} bytesPerRow={64} scope scenarios={scenarios} defaultSize={24} />;
}

// ---------------- Arena ----------------

const arenaSchema = {
  chunk: select({ label: "Chunk size", options: ["128", "256", "512"].map((v) => ({ value: v, label: `${v} B` })), default: "256", segmented: true }),
};

export function ArenaDemo() {
  const params = useParams("arena", arenaSchema);
  const chunk = Number(params.values.chunk);
  const scenarios: Scenario[] = [
    { label: "3 × 100 B", run: (h) => [0, 1, 2].map((i) => `alloc(100) #${i + 1} → ${hex(h.alloc(100, 1))}`) },
    {
      label: "Frame loop",
      run: (h) => {
        const out: string[] = [];
        for (let frame = 1; frame <= 3; frame++) {
          const m = h.mark();
          for (let i = 0; i < 6; i++) h.alloc(24 + ((frame * 37 + i * 53) % 120), 8);
          out.push(`frame ${frame}: ${h.stats().live} B live, then end scope`);
          if (frame < 3) h.restore(m);
        }
        return out;
      },
    },
  ];
  return (
    <HeapPlayground
      title="Chunked arena · 2 KiB backing memory"
      config={{ kind: "arena", cap: 2048, a: chunk }}
      kinds={[L, F, M, P, S, D]}
      controls={<Controls params={params} />}
      bytesPerRow={128}
      scope
      scenarios={scenarios}
      defaultSize={60}
      maxSize={600}
    />
  );
}

// ---------------- Pool ----------------

const poolSchema = {
  slot: select({ label: "Slot size", options: ["16", "32", "48", "64", "128"].map((v) => ({ value: v, label: `${v} B` })), default: "64", segmented: true }),
};

export function PoolDemo() {
  const params = useParams("pool", poolSchema);
  const slot = Number(params.values.slot);
  const scenarios: Scenario[] = [
    {
      label: "A, B, C · free A · free C",
      run: (h) => {
        const a = h.alloc(slot, 8), b = h.alloc(slot, 8), c = h.alloc(slot, 8);
        h.free(a!);
        h.free(c!);
        return [`A = ${hex(a)}, B = ${hex(b)}, C = ${hex(c)}`, "free(A), free(C)", "free list head is now C, then A, then the untouched slots"];
      },
    },
  ];
  return (
    <HeapPlayground
      title="Pool allocator · 1 KiB"
      config={{ kind: "pool", cap: 1024, a: slot }}
      kinds={[L, F, S]}
      controls={<Controls params={params} />}
      bytesPerRow={128}
      links
      hideFrag
      scenarios={scenarios}
      defaultSize={Math.min(40, slot)}
      maxSize={160}
      randomSize={(r) => 1 + Math.floor(r() * slot)}
    />
  );
}

// ---------------- Free list ----------------

const freeListSchema = {
  fit: select({ label: "Placement", options: [{ value: "0", label: "First fit" }, { value: "1", label: "Next fit" }, { value: "2", label: "Best fit" }, { value: "3", label: "Worst fit" }], default: "0", segmented: true }),
  coalesce: toggle({ label: "Coalesce adjacent free blocks", default: true }),
};

export function FreeListDemo() {
  const params = useParams("fl", freeListSchema);
  const { fit, coalesce } = params.values;
  const scenarios: Scenario[] = [
    {
      label: "Fill, free all, ask for 1 KiB",
      run: (h) => {
        const xs = Array.from({ length: 14 }, () => h.alloc(120, 8));
        xs.forEach((x) => x !== null && h.free(x));
        const s = h.stats();
        return [`14 × alloc(120), then free all → ${s.free} B free, largest block ${s.largestFree} B`, `alloc(1024) → ${hex(h.alloc(1024, 8))}`];
      },
    },
    {
      label: "Swiss cheese",
      run: (h) => {
        const big: number[] = [];
        for (let i = 0; i < 200; i++) {
          const x = h.alloc(i % 2 ? 40 : 100, 8);
          if (x === null) break;
          if (i % 2 === 0) big.push(x);
        }
        big.forEach((x) => h.free(x));
        const s = h.stats();
        return [`alternate 100 B and 40 B until full, free every 100 B block`, `${s.free} B free, largest block ${s.largestFree} B`, `alloc(200) → ${hex(h.alloc(200, 8))}`];
      },
    },
  ];
  return (
    <HeapPlayground
      title="Free-list allocator · 2 KiB · 8-byte headers"
      config={{ kind: "freelist", cap: 2048, a: Number(fit), b: coalesce ? 1 : 0 }}
      kinds={[L, F, M, P, S]}
      controls={<Controls params={params} />}
      bytesPerRow={128}
      links
      scenarios={scenarios}
      defaultSize={80}
      maxSize={1024}
      randomSize={(r) => 8 + Math.floor(r() * 220)}
    />
  );
}

// ---------------- Buddy ----------------

function buddyBlocks(h: Heap) {
  const counts = new Map<number, number>();
  for (const r of h.regions()) if (r.kind === REGION.free) counts.set(r.len, (counts.get(r.len) ?? 0) + 1);
  const s = [...counts].sort((a, b) => b[0] - a[0]).map(([len, n]) => `${n}×${len}`).join(" ");
  return s || "none";
}

export function BuddyDemo() {
  const scenarios: Scenario[] = [
    { label: "alloc(33)", run: (h) => [`alloc(33) → ${hex(h.alloc(33, 1))}`, `split 1024 → 512 → 256 → 128 → 64; free blocks: ${buddyBlocks(h)}`] },
    {
      label: "Four 100 B, free in order",
      run: (h) => {
        const xs = [0, 1, 2, 3].map(() => h.alloc(100, 1)!);
        const out = [`4 × alloc(100) → ${xs.map(hex).join(", ")}; free: ${buddyBlocks(h)}`];
        xs.forEach((x) => { h.free(x); out.push(`free(${hex(x)}) → free blocks: ${buddyBlocks(h)}`); });
        return out;
      },
    },
  ];
  return (
    <HeapPlayground
      title="Binary buddy allocator · 1 KiB · 16 B minimum"
      config={{ kind: "buddy", cap: 1024 }}
      kinds={[L, F, S]}
      bytesPerRow={64}
      scenarios={scenarios}
      defaultSize={33}
      maxSize={1024}
      aligns={[1, 8, 64]}
      randomSize={(r) => 4 + Math.floor(r() * r() * 200)}
      extraStats={(h) => [{ label: "free blocks", value: <span style={{ fontSize: 13 }}>{buddyBlocks(h)}</span> }]}
    />
  );
}

// ---------------- Slab ----------------

const slabSchema = {
  keep: toggle({ label: "Keep one empty slab per cache", default: false }),
};

const slabPages = (h: Heap) => h.regions().filter((r) => r.kind === REGION.meta).length;

export function SlabDemo() {
  const params = useParams("slab", slabSchema);
  const keep = params.values.keep;
  const scenarios: Scenario[] = [
    {
      label: "alloc + free one 40 B object × 10",
      run: (h) => {
        let grabs = 0;
        for (let i = 0; i < 10; i++) {
          const before = slabPages(h);
          const a = h.alloc(40, 8)!;
          if (slabPages(h) > before) grabs++;
          h.free(a);
        }
        return [`10 alloc/free pairs → ${grabs} page${grabs === 1 ? "" : "s"} taken from the page pool`];
      },
    },
    {
      label: "Mixed objects",
      run: (h) => {
        const sizes = [24, 24, 24, 60, 60, 120, 120, 200, 16, 16, 16, 16, 48, 48, 100];
        sizes.forEach((s) => h.alloc(s, 8));
        return [`${sizes.length} objects of sizes ${[...new Set(sizes)].join(", ")}`, `${slabPages(h)} slabs in use`];
      },
    },
  ];
  return (
    <HeapPlayground
      title="Slab allocator · 4 KiB · 512 B pages"
      config={{ kind: "slab", cap: 4096, a: 512, b: keep ? 1 : 0 }}
      kinds={[L, F, M, S]}
      controls={<Controls params={params} />}
      bytesPerRow={512}
      scenarios={scenarios}
      defaultSize={40}
      maxSize={256}
      aligns={[1, 8, 16]}
      randomSize={(r) => [16, 24, 40, 60, 100, 200][Math.floor(r() * 6)]!}
      extraStats={(h) => [{ label: "slabs in use", value: slabPages(h) }]}
    />
  );
}

// ---------------- Size classes ----------------

const scSchema = {
  classes: select({ label: "Size classes", options: [{ value: "pow2", label: "Powers of two" }, { value: "fine", label: "16 B steps, then ~25%" }], default: "pow2", segmented: true }),
};

export function SizeClassDemo() {
  const params = useParams("sc", scSchema);
  const fine = params.values.classes === "fine";
  return (
    <HeapPlayground
      title="Size-class allocator · 16 KiB · 1 KiB pages"
      config={{ kind: "sizeclass", cap: 16384, a: 1024, b: fine ? 1 : 0 }}
      kinds={[L, F, S]}
      controls={<Controls params={params} />}
      bytesPerRow={1024}
      scenarios={[
        { label: "alloc(33)", run: (h) => [`alloc(33) → ${hex(h.alloc(33, 8))}, rounded to ${fine ? 48 : 64} B`] },
        { label: "alloc(3000)", run: (h) => [`alloc(3000) → ${hex(h.alloc(3000, 8))}: large path, 3 whole pages`] },
      ]}
      defaultSize={33}
      maxSize={3000}
      aligns={[1, 8, 16]}
      randomSize={(r) => Math.round(8 * Math.exp(r() * 4.2))}
      extraStats={(_, s) => [{ label: "slack / live", value: s.live ? `${Math.round((100 * s.slack) / s.live)}%` : "–" }]}
    />
  );
}
