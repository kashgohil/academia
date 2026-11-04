/** Demos for "block allocation and extents": a block grid and a size calculator. */
import { useMemo } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, bytes, pct, range, select, toggle, useParams } from "../../kit";
import { ALLOC_DEFAULTS, AllocSim, POLICY_LABEL, ext2Limit, fragReadCost, indirectMeta, mappingCompare, maxFileSize, type AllocMetrics, type AllocPolicy, type IndirectSpec } from "../../sims/os/fs/alloc";
import { Heading, MONO, MiniTable, Note, fileColor } from "./FsUi";

const POLICIES: AllocPolicy[] = ["immediate", "delayed", "prealloc"];
const G = {
  rounds: range({ label: "Rounds of writing", min: 1, max: 400, step: 1, default: 120 }),
  policy: select({ label: "Policy", segmented: true, options: POLICIES.map((p) => ({ value: p, label: POLICY_LABEL[p] })), default: "immediate" }),
  writers: range({ label: "Files growing at once", min: 1, max: 6, step: 1, default: ALLOC_DEFAULTS.writers }),
  chunk: range({ label: "Blocks per write", min: 1, max: 8, step: 1, default: ALLOC_DEFAULTS.chunk }),
};

/** Like the kit's bytes(), and it goes on past GiB, since this demo reaches far larger sizes. */
function bigBytes(v: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB"];
  let u = 0, x = v;
  while (x >= 1024 && u < units.length - 1) { x /= 1024; u++; }
  return `${+x.toPrecision(3)} ${units[u]}`;
}

const COLS = 32;
const CELL = 12;
const BLOCK_BYTES = 4096;

function run(policy: AllocPolicy, rounds: number, writers: number, chunk: number) {
  return new AllocSim({ ...ALLOC_DEFAULTS, policy, writers, chunk }).run(rounds);
}

export function FsAllocGridDemo() {
  const P = useParams("os-fs-alloc", G);
  const { rounds, writers, chunk } = P.values;
  const policy = P.values.policy as AllocPolicy;
  const all = useMemo(() => POLICIES.map((p) => run(p, rounds, writers, chunk)), [rounds, writers, chunk]);
  const sim = all[POLICIES.indexOf(policy)]!;
  const m: AllocMetrics = sim.metrics();
  const rows = Math.ceil(ALLOC_DEFAULTS.blocks / COLS);
  const fileOf = new Map(sim.files.map((f) => [f.id, f]));

  const costRows = all.map((s, i) => {
    const x = s.metrics();
    const avgBytes = x.files ? (x.usedBlocks / x.files) * BLOCK_BYTES : 0;
    const one = fragReadCost(avgBytes, 1);
    const frag = fragReadCost(avgBytes, Math.max(1, x.meanFragments));
    return [
      ({ immediate: "At write", delayed: "Delayed", prealloc: "fallocate" } as const)[POLICIES[i]!],
      x.meanFragments.toFixed(1),
      x.extents,
      bytes(x.extentMetaBytes),
      bytes(x.indirectMeta * BLOCK_BYTES),
      `${(frag.hddMs / one.hddMs).toFixed(1)}x`,
      `${(frag.ssdMs / one.ssdMs).toFixed(2)}x`,
    ];
  });

  return (
    <Demo title="Files on a block grid" controls={<>
      <Param spec={G.rounds} value={rounds} onChange={(v) => P.set("rounds", v as number)} />
      <Param spec={G.writers} value={writers} onChange={(v) => P.set("writers", v as number)} />
      <Param spec={G.chunk} value={chunk} onChange={(v) => P.set("chunk", v as number)} />
      <Param spec={G.policy} value={policy} onChange={(v) => P.set("policy", v as never)} />
    </>}>
      <svg viewBox={`0 0 ${COLS * CELL} ${rows * CELL}`} style={{ width: "100%", maxWidth: 640, display: "block" }} role="img" aria-label="disk blocks, colored by file">
        {Array.from(sim.owner).map((o, i) => {
          const f = fileOf.get(o);
          const unwritten = !!f && f.reserved.includes(i);
          return <rect key={i} x={(i % COLS) * CELL + 0.5} y={Math.floor(i / COLS) * CELL + 0.5} width={CELL - 1} height={CELL - 1} rx={1.5} fill={o ? fileColor(o) : "var(--subtle)"} opacity={!o ? 1 : unwritten ? 0.3 : f?.done ? 0.85 : 0.55} />;
        })}
      </svg>
      <Note>Each color is a file, though colors repeat. A pale block belongs to a file that is still growing. The palest blocks are reserved by fallocate and hold no data yet.</Note>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "files", value: m.files },
          { label: "files deleted so far", value: sim.deleted },
          { label: "used blocks", value: `${m.usedBlocks} / ${ALLOC_DEFAULTS.blocks}` },
          { label: "pieces per file", value: m.meanFragments.toFixed(1) },
          { label: "free runs", value: m.freeRuns },
          { label: "largest free run", value: m.largestFree },
        ]} />
      </div>
      <div style={{ marginTop: 10 }}>
        <Heading>All three policies at this point</Heading>
        <MiniTable
          head={["Policy", "Pieces", "Extents", "Tree", "Indirect", "HDD", "SSD"]}
          rows={costRows}
          highlight={(i) => POLICIES[i] === policy}
        />
      </div>
      <Note>Pieces is per file. Tree is the extent tree, and Indirect is the indirect blocks. HDD and SSD give the read slowdown. It compares a mean file read in its pieces with the same file in one piece. It uses the 7,200 rpm and NVMe models of the databases track. The worst case for the disk is a full seek for each piece, and that is what the model charges.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- calculator

const K = {
  blockSize: select({ label: "Block size", segmented: true, options: [1024, 2048, 4096, 8192, 65536].map((b) => ({ value: String(b), label: bytes(b) })), default: "4096" }),
  ptrBytes: select({ label: "Pointer size", segmented: true, options: [{ value: "4", label: "4 bytes" }, { value: "8", label: "8 bytes" }], default: "4" }),
  direct: range({ label: "Direct pointers", min: 0, max: 24, step: 1, default: 12 }),
  levels: range({ label: "Indirect levels", min: 0, max: 4, step: 1, default: 3 }),
  file: range({ label: "File size", min: 4096, max: 1.1e12, log: true, default: 1073741824, format: (v) => bigBytes(Math.round(v)) }),
  frag: toggle({ label: "Fragment the file: one extent per 16 blocks", default: false }),
};

const FILE_SIZES = Array.from({ length: 41 }, (_, i) => 4096 * Math.pow(2, i * 0.7));

export function FsMaxSizeDemo() {
  const P = useParams("os-fs-maxsize", K);
  const { direct, levels, file, frag } = P.values;
  const blockSize = Number(P.values.blockSize), ptrBytes = Number(P.values.ptrBytes);
  const spec: IndirectSpec = { blockSize, ptrBytes, direct, levels };
  const mx = maxFileSize(spec);
  const fileBytes = Math.round(file);
  const fragsOf = (b: number) => (frag ? Math.ceil(Math.ceil(b / blockSize) / 16) : 1);
  const cmp = mappingCompare(fileBytes, fragsOf(fileBytes), spec);
  const fits = fileBytes <= mx.maxBytes;
  const sizes = FILE_SIZES.filter((b) => b <= mx.maxBytes);
  const indLine = sizes.flatMap((b) => {
    const c = mappingCompare(b, fragsOf(b), spec);
    return c.indirectOverhead > 0 ? [[b, c.indirectOverhead * 100] as [number, number]] : [];
  });
  const extLine = FILE_SIZES.flatMap((b) => {
    const c = mappingCompare(b, fragsOf(b), spec);
    return c.extentOverhead > 0 ? [[b, c.extentOverhead * 100] as [number, number]] : [];
  });
  const levelNames = ["direct", "single", "double", "triple", "quadruple"];
  return (
    <Demo title="Maximum file size and metadata overhead" controls={<>
      <Param spec={K.direct} value={direct} onChange={(v) => P.set("direct", v as number)} />
      <Param spec={K.levels} value={levels} onChange={(v) => P.set("levels", v as number)} />
      <Param spec={K.file} value={file} onChange={(v) => P.set("file", v as number)} />
      <Param spec={K.blockSize} value={P.values.blockSize} onChange={(v) => P.set("blockSize", v as never)} />
      <Param spec={K.ptrBytes} value={P.values.ptrBytes} onChange={(v) => P.set("ptrBytes", v as never)} />
      <Param spec={K.frag} value={frag} onChange={(v) => P.set("frag", v as boolean)} />
    </>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
        <div>
          <Heading>What each part of the inode reaches</Heading>
          <div style={{ fontFamily: MONO, fontSize: 12 }}>
            {mx.perLevel.map((n, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", padding: "2px 0" }}>
                <span>{levelNames[i]}</span>
                <span style={{ textAlign: "right" }}>{n.toLocaleString("en-US")} blocks = {bigBytes(n * blockSize)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontWeight: 650 }}>
              <span>maximum</span><span>{bigBytes(mx.maxBytes)}</span>
            </div>
          </div>
          <Note>{mx.ptrs} pointers fit in one block. {ptrBytes === 4 && direct === 12 && levels === 3 && blockSize <= 4096 && `ext2 caps this at ${bigBytes(ext2Limit(blockSize).limit)}, because i_blocks counts 512-byte units in 32 bits.`}</Note>
        </div>
        <div>
          <Heading>Overhead against file size</Heading>
          <Plot x={[4096, FILE_SIZES[FILE_SIZES.length - 1]!]} y={[1e-6, 10]} logX logY height={190} xLabel="file size" yLabel="metadata, % of file" xTicks={[4096, 1 << 20, 1 << 30, 2 ** 40]} xFormat={(v) => bigBytes(v)} yTicks={[1e-5, 1e-3, 0.1, 10]} yFormat={(v) => `${v}`}>
            <Line points={indLine} color="var(--c4)" />
            <Line points={extLine} color="var(--c3)" />
            <RuleX at={fileBytes} />
          </Plot>
          <Legend items={[{ label: "indirect", color: "var(--c4)" }, { label: "extents", color: "var(--c3)" }]} />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "indirect metadata", value: fits && spec.levels >= 0 ? bigBytes(indirectMeta(cmp.blocks, spec).metaBytes) : "too large" },
          { label: "indirect overhead", value: fits ? pct(cmp.indirectOverhead, 3) : "too large" },
          { label: "extents needed", value: cmp.extents },
          { label: "extent tree", value: `${bigBytes(cmp.extentBytes)}, depth ${cmp.extentDepth}` },
          { label: "extent overhead", value: pct(cmp.extentOverhead, 5) },
        ]} />
      </div>
      <Note>An extent covers at most 32,768 blocks. Extents here assume ext4's on-disk format at this block size. Up to 4 extents fit in the inode and need no block, so the extent line starts where the tree needs its first block.</Note>
    </Demo>
  );
}
