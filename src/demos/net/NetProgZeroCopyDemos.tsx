/** Demos for "Zero copy": count the copies of each send path, find where MSG_ZEROCOPY pays, and the cores to receive at line rate. */
import { useMemo } from "react";
import { Banner, Demo, Legend, Line, MiniTable, Note, Param, Plot, RuleX, SmallLabel, StackBar, Stats, bytes, fixed, int, mono, range, seg, select, useParams, useWidth, Arrow } from "../../kit";
import {
  COPY_PATHS, LANES, RX_DESIGNS, RX_LABEL, ZC_DEFAULT_INPUTS, ZC_MODEL, pathById, pathCost, rxCores, zcCrossover, zcHeldBytes, zcSendCost,
  type Lane, type Mover, type PathId,
} from "../../sims/net/programming";

// ============================================================================ 1. Count the copies

const CP = {
  size: range({ label: "Bytes per request", min: 4096, max: 16 * 1024 * 1024, log: true, default: 1024 * 1024, format: (v) => bytes(v) }),
  path: select<PathId>({ label: "Send path", options: COPY_PATHS.map((p) => ({ value: p.id, label: `${p.source === "file" ? "File" : "Memory"}: ${p.label}` })), default: "readwrite" }),
};

const MOVER: Record<Mover, { color: string; text: string; dash?: string }> = {
  cpu: { color: "var(--c4)", text: "CPU copy" },
  crypto: { color: "var(--c5)", text: "CPU encrypt" },
  dma: { color: "var(--c3)", text: "DMA" },
  "nic-crypto": { color: "var(--c3)", text: "DMA, NIC encrypts" },
  ref: { color: "var(--muted)", text: "page reference", dash: "4 3" },
};

function PathDiagram({ id }: { id: PathId }) {
  const p = pathById(id);
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(300, width);
  const h = 196;
  const boxW = Math.min(118, (w - 30) / 4.4);
  const xs = LANES.map((_, i) => 8 + boxW / 2 + (i * (w - 16 - boxW)) / 3);
  const by = 112;
  const cx = (l: Lane) => xs[LANES.indexOf(l)]!;
  const user = (l: Lane) => l === "user buffer";
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg width={w} height={h} style={{ display: "block" }} role="img" aria-label="data path">
        <defs>
          {Object.entries(MOVER).map(([k, v]) => <Arrow key={k} id={`zc-${k}`} color={v.color} />)}
        </defs>
        <line x1={0} x2={w} y1={by - 22} y2={by - 22} stroke="var(--border)" strokeDasharray="2 3" />
        <text x={4} y={by - 27} fontSize={10.5} fill="var(--muted)">user ↑</text>
        <text x={4} y={by - 11} fontSize={10.5} fill="var(--muted)">kernel ↓</text>
        {LANES.map((l, i) => (
          <g key={l}>
            <rect x={xs[i]! - boxW / 2} y={user(l) ? 18 : by} width={boxW} height={34} rx={5} fill="var(--bg)" stroke="var(--border)" strokeWidth={1.5} />
            <text x={xs[i]} y={(user(l) ? 18 : by) + 21} textAnchor="middle" fontSize={11.5} fill="var(--fg)">{l}</text>
          </g>
        ))}
        {p.moves.map((m, i) => {
          const v = MOVER[m.by];
          const y1 = user(m.from) ? 52 : by, y2 = user(m.to) ? 18 + 34 : by;
          const x1 = cx(m.from), x2 = cx(m.to);
          if (m.from === m.to) {
            // an in-place pass in the user buffer (encryption into a second buffer)
            return (
              <g key={i}>
                <path d={`M${x1 - 18},18 C${x1 - 18},-6 ${x1 + 18},-6 ${x1 + 18},16`} fill="none" stroke={v.color} strokeWidth={2} markerEnd={`url(#zc-${m.by})`} />
                <text x={x1 + 24} y={10} fontSize={10.5} fill={v.color}>{v.text}</text>
              </g>
            );
          }
          const sameRow = y1 === by && y2 === by;
          const lift = sameRow ? 26 + 14 * (i % 2) : 0;
          const d = sameRow
            ? `M${x1},${by + 34} C${x1},${by + 34 + lift} ${x2},${by + 34 + lift} ${x2},${by + 36}`
            : `M${x1},${y1} L${x2},${y2}`;
          const lx = (x1 + x2) / 2 + (sameRow ? 0 : m.by === "ref" ? -6 : 6), ly = sameRow ? by + 34 + lift * 0.8 : (y1 + y2) / 2 - 4;
          const anchor = sameRow ? "middle" : m.by === "ref" ? "end" : "start";
          return (
            <g key={i}>
              <path d={d} fill="none" stroke={v.color} strokeWidth={2} strokeDasharray={v.dash} markerEnd={`url(#zc-${m.by})`} />
              <text x={lx} y={ly} textAnchor={anchor} fontSize={10.5} fill={v.color} stroke="var(--bg)" strokeWidth={3} paintOrder="stroke">{v.text}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function NetProgCopyPathDemo() {
  const P = useParams("net-prog-copy", CP);
  const { size, path } = P.values;
  const id = path as PathId;
  const c = pathCost(id, size);
  const others = COPY_PATHS.filter((p) => p.source === c.path.source).map((p) => pathCost(p.id, size));
  return (
    <Demo
      title="Where the bytes go on the way to the NIC"
      controls={<>
        <Param spec={CP.size} value={size} onChange={(v) => P.set("size", v as number)} />
        <Param spec={CP.path} value={path} onChange={(v) => P.set("path", v as PathId)} />
      </>}
    >
      <PathDiagram id={id} />
      <Banner tone={c.cpuCopies + c.cryptoPasses === 0 ? "good" : c.cpuCopies + c.cryptoPasses > 1 ? "bad" : "warn"}>{c.path.note}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "CPU passes over each byte", value: `${c.cpuCopies + c.cryptoPasses}` },
          { label: "system calls", value: fixed(c.calls, Number.isInteger(c.calls) ? 0 : 2) },
          { label: "CPU per request", value: `${fixed(c.ns / 1000, 1)} µs` },
          { label: "cores to send 100 Gbit/s", value: fixed(c.coresAt(100)) },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 10 }}>All {c.path.source === "file" ? "ways to send a file that is in the page cache" : "ways to send bytes the program made"}, at {bytes(size)} per request</SmallLabel>
      <MiniTable
        head={["path", "CPU passes", "calls", "µs", "cores, 100G"]}
        rows={others.map((o) => [o.path.label, `${o.cpuCopies + o.cryptoPasses}`, fixed(o.calls, Number.isInteger(o.calls) ? 0 : 2), fixed(o.ns / 1000, 1), fixed(o.coresAt(100))])}
        highlight={others.findIndex((o) => o.path.id === id)}
      />
      <Note>Model inputs: a copy runs at {ZC_MODEL.copyGBps} GB/s per core, AES-GCM at {ZC_MODEL.cryptoGBps} GB/s, a system call costs {int(ZC_MODEL.syscallNs)} ns, a page reference {ZC_MODEL.pageRefNs} ns, a pinned page {ZC_MODEL.pinNs} ns.{c.path.source === "file" ? " The file is already in the page cache; a cold file adds one disk DMA to every path." : " The zero-copy rows include the notifications."}</Note>
    </Demo>
  );
}

// ============================================================================ 2. When MSG_ZEROCOPY pays

const ZC = {
  copy: range({ label: "Copy speed (model input)", min: 2, max: 20, step: 1, default: ZC_DEFAULT_INPUTS.copyGBps, format: (v) => `${v} GB/s` }),
  pin: range({ label: "Pin and unpin, per 4 KiB page (model input)", min: 20, max: 200, step: 10, default: ZC_DEFAULT_INPUTS.pinNs, format: (v) => `${v} ns` }),
  batch: range({ label: "Sends per notification read", min: 1, max: 32, step: 1, default: ZC_DEFAULT_INPUTS.sendsPerNotify }),
  rtt: range({ label: "Round-trip time", min: 1, max: 200, step: 1, default: 50, format: (v) => `${v} ms` }),
};

export function NetProgZcThresholdDemo() {
  const P = useParams("net-prog-zc", ZC);
  const { copy, pin, batch, rtt } = P.values;
  const inputs = { ...ZC_DEFAULT_INPUTS, copyGBps: copy, pinNs: pin, sendsPerNotify: batch };
  const cross = zcCrossover(inputs);
  const sizes = Array.from({ length: 61 }, (_, i) => 512 * 2 ** (i / 6));
  const pts = sizes.map((b) => ({ b, ...zcSendCost(b, inputs) }));
  const held = zcHeldBytes(10, rtt);
  const at64 = zcSendCost(65536, inputs);
  return (
    <Demo
      title="send() with a copy, or with MSG_ZEROCOPY"
      controls={<>
        <Param spec={ZC.copy} value={copy} onChange={(v) => P.set("copy", v as number)} />
        <Param spec={ZC.pin} value={pin} onChange={(v) => P.set("pin", v as number)} />
        <Param spec={ZC.batch} value={batch} onChange={(v) => P.set("batch", v as number)} />
        <Param spec={ZC.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
      </>}
    >
      <Plot x={[512, 1024 * 1024]} y={[100, 200_000]} logX logY height={230} xLabel="bytes per send" yLabel="CPU ns per send" xFormat={(v) => bytes(v)} xTicks={[1024, 8192, 65536, 524288]} yTicks={[100, 1000, 10_000, 100_000]} yFormat={(v) => sigShort(v)}>
        {cross && <RuleX at={cross} label={`crossover ${bytes(cross)}`} color="var(--c3)" />}
        <Line points={pts.map((p) => [p.b, p.copy] as const)} color="var(--c4)" />
        <Line points={pts.map((p) => [p.b, p.zc] as const)} color="var(--c1)" />
      </Plot>
      <Legend items={[{ label: "copy into the socket buffer", color: "var(--c4)" }, { label: "MSG_ZEROCOPY: pin, notify", color: "var(--c1)" }]} />
      <Banner tone={cross && cross <= 16384 ? "good" : "warn"}>
        {cross
          ? `Below ${bytes(cross)}, the copy is cheaper: pinning pages and reading notifications cost more than copying a few pages. At 64 KiB, zero copy uses ${int(at64.zc)} ns instead of ${int(at64.copy)} ns.`
          : "With these inputs, zero copy never wins below 4 MiB."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "crossover", value: cross ? bytes(cross) : "none" },
          { label: "buffers held at 10 Gbit/s", value: bytes(held) },
        ]} />
      </div>
      <Note>With TCP, the kernel can free a zero-copy page only after the peer acknowledges the data, because it may have to send it again. So at 10 Gbit/s and an RTT of {rtt} ms, about {bytes(held)} of your buffers are locked at any time. Fixed cost per send: {ZC_DEFAULT_INPUTS.zcFixedNs} ns; a notification read: {ZC_DEFAULT_INPUTS.notifyNs} ns (model inputs).</Note>
    </Demo>
  );
}

const sigShort = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`);

// ============================================================================ 3. Cores to receive at line rate

const RX = {
  rate: seg<string>("Line rate", [["10", "10G"], ["25", "25G"], ["100", "100G"], ["400", "400G"]], "100"),
  traffic: seg<string>("Traffic", [["bulk1500", "Bulk, MTU 1500"], ["bulk9000", "Bulk, MTU 9000"], ["small", "64-byte frames"]], "bulk1500"),
};

const RX_PARTS = [
  { key: "driver", label: "driver per packet", color: "var(--c2)" },
  { key: "stack", label: "IP and TCP per pass", color: "var(--c1)" },
  { key: "csum", label: "checksum", color: "var(--c5)" },
  { key: "copy", label: "copy to the program", color: "var(--c4)" },
] as const;

export function NetProgRxCoresDemo() {
  const P = useParams("net-prog-rx", RX);
  const { rate, traffic } = P.values;
  const frame = traffic === "bulk9000" ? 9018 : traffic === "small" ? 64 : 1518;
  const kind = traffic === "small" ? "small" : "bulk";
  const rows = useMemo(() => RX_DESIGNS.map((d) => rxCores(d, Number(rate), frame, kind)), [rate, frame, kind]);
  const max = Math.max(...rows.map((r) => r.cores));
  const first = rows[0]!;
  return (
    <Demo
      title="Cores to receive at line rate"
      controls={<>
        <Param spec={RX.rate} value={rate} onChange={(v) => P.set("rate", v as string)} />
        <Param spec={RX.traffic} value={traffic} onChange={(v) => P.set("traffic", v as string)} />
      </>}
    >
      <div style={{ ...mono, fontSize: 12.5, marginBottom: 8 }}>
        {fixed(first.pps / 1e6, 2)} million frames per second · {fixed(first.budgetNs, 1)} ns per frame for one core
      </div>
      {rows.map((r) => (
        <div key={r.design} style={{ margin: "6px 0 10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5 }}>
            <span>{RX_LABEL[r.design]}</span>
            <span style={{ ...mono }}>{fixed(r.cores, 1)} cores</span>
          </div>
          <StackBar total={max} height={14} parts={RX_PARTS.map((p) => ({ value: r.parts[p.key], color: p.color, label: `${p.label}: ${fixed(r.parts[p.key])} cores` }))} />
        </div>
      ))}
      <Legend items={RX_PARTS.map((p) => ({ label: p.label, color: p.color }))} />
      <Banner tone="plain">
        {kind === "bulk"
          ? "With one long flow, GRO merges the frames of each burst into one packet of up to 64 KiB, so IP and TCP run far less often. The copy to the program is now the largest part."
          : "Small messages give GRO nothing to merge, so every frame pays for the whole stack. Here kernel bypass wins by a large factor, at the cost of a core that always spins and no kernel TCP."}
      </Banner>
      <Note>Model inputs: 100 ns of driver work per frame, 1000 ns per pass through IP and TCP, checksum at 10 GB/s, copy at 8 GB/s, 60 ns per frame for a bypass poll loop with no TCP stack. A bypass design keeps at least one core busy even with no traffic. The frame rates are Ethernet facts: each frame also uses 20 bytes of preamble and gap.</Note>
    </Demo>
  );
}
