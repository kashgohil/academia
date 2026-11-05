/** Demos for the Storage module, lessons 4–6: buffer pools, durability, amplification. */
import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Demo, Stats, Param, Plot, Line, RuleX, Dots, Legend, range, toggle, select, useParams, bytes, pct, Meter, Note, SmallLabel, mono, seg, sig, useChunked } from "../../kit";
import {
  BufferPool, BufferPoolFullError, type PolicyId, POLICY_LABEL, mixedTrace, runTrace,
  SCENARIOS, runScenario, type DeviceCache, lostOnCrash, visible, type StackOp,
  tornUpdate, crashRecover, PROTECTION_LABEL, OUTCOME_LABEL, type Protection, type SectorOrder, type Outcome, pageBytes, hex32, checkpointCost,
  designSpace, AMP_ENV, FAMILY_LABEL, type FamilyId, rumWeights, readCost, enginePresets, deviceWa, chain,
} from "../../sims/db/storage";

// =====================================================================================
// Lesson 4: Buffer pools
// =====================================================================================

const POLICY_OPTS: [PolicyId, string][] = [["lru", "LRU"], ["clock", "Clock"], ["lru2", "LRU-2"], ["2q", "2Q"], ["midpoint", "Midpoint"], ["pg", "Clock sweep"]];
const N_FRAMES = 4;

type BpEvent = { text: string; warn?: boolean; frame?: number; hit?: boolean };

export function BufferPoolStepperDemo() {
  const p = useParams("bpstep", {
    page: range({ label: "Page to fetch", min: 1, max: 9, step: 1, default: 1 }),
    policy: seg<PolicyId>("Replacement policy", POLICY_OPTS, "lru"),
    write: toggle({ label: "Change the page (it becomes dirty)", default: false }),
    keep: toggle({ label: "Keep it pinned after the fetch", default: false }),
  });
  const v = p.values;
  const bp = useRef<BufferPool | null>(null);
  const io = useRef<{ reads: number[]; writes: number[]; last: string }>({ reads: [], writes: [], last: "" });
  const [ev, setEv] = useState<BpEvent>({ text: "Fetch pages. Each fetch pins the page; the demo unpins it again unless you keep it pinned." });
  const [, force] = useState(0);
  const make = (pol: PolicyId) => {
    io.current = { reads: [], writes: [], last: "" };
    bp.current = new BufferPool(N_FRAMES, pol, {
      read: (pg) => { io.current.reads.push(pg); io.current.last = `read page ${pg} from disk`; },
      write: (pg) => { io.current.writes.push(pg); io.current.last = `wrote dirty page ${pg} to disk, then read`; },
    });
  };
  if (!bp.current) make(v.policy);
  const pool = bp.current!;
  const fetch = (page: number, scan = false, write = v.write, keep = v.keep) => {
    io.current.last = "";
    try {
      const r = pool.fetch(page, { scan });
      if (!keep) pool.unpin(page, write);
      else if (write) pool.frames[r.frame]!.dirty = true;
      const what = r.hit
        ? `Hit: page ${page} is in frame ${r.frame}. No disk I/O.`
        : `Miss: ${r.evicted ? `the policy chose frame ${r.frame} (page ${r.evicted.page}${r.evicted.dirty ? ", dirty, so it is written back first" : ""}). ` : `frame ${r.frame} was empty. `}Page ${page} is read into it.`;
      return { text: what + (keep ? " It stays pinned." : ""), frame: r.frame, hit: r.hit };
    } catch (e) {
      if (e instanceof BufferPoolFullError) return { text: `Cannot fetch page ${page}: every frame is pinned, so no frame can be a victim. Unpin a page first.`, warn: true };
      throw e;
    }
  };
  const doFetch = () => { setEv(fetch(v.page)); force((x) => x + 1); };
  const doScan = () => {
    let last: BpEvent = { text: "" };
    for (let pg = 10; pg <= 17; pg++) last = fetch(pg, true, false, false);
    setEv({ ...last, text: `A scan read pages 10 to 17 once each. ${last.text}` });
    force((x) => x + 1);
  };
  const unpinAll = () => { for (const f of pool.frames) while (f.pins > 0) pool.unpin(f.page); setEv({ text: "All pins released." }); force((x) => x + 1); };
  const flushAll = () => { const n = pool.flushAll(); setEv({ text: `Flushed ${n} dirty page${n === 1 ? "" : "s"}. They stay in the pool, now clean.` }); force((x) => x + 1); };
  const order = pool.policy.order();
  return (
    <Demo
      title={`A buffer pool with ${N_FRAMES} frames`}
      actions={<button className="btn ghost" onClick={() => { make(v.policy); setEv({ text: "Pool emptied." }); force((x) => x + 1); }}>Reset</button>}
      controls={<>
        <Param spec={p.schema.page} value={v.page} onChange={(x) => p.set("page", x as number)} />
        <Param spec={p.schema.policy} value={v.policy} onChange={(x) => { p.set("policy", x as PolicyId); make(x as PolicyId); setEv({ text: `Policy: ${POLICY_LABEL[x as PolicyId]}. Pool emptied.` }); }} />
        <Param spec={p.schema.write} value={v.write} onChange={(x) => p.set("write", x as boolean)} />
        <Param spec={p.schema.keep} value={v.keep} onChange={(x) => p.set("keep", x as boolean)} />
      </>}
    >
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <button className="btn" onClick={doFetch}>Fetch page {v.page}</button>
        <button className="btn" onClick={doScan}>Scan pages 10–17</button>
        <button className="btn ghost" onClick={unpinAll}>Unpin all</button>
        <button className="btn ghost" onClick={flushAll}>Flush dirty pages</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${N_FRAMES}, minmax(0, 1fr))`, gap: 8 }}>
        {pool.frames.map((f, i) => {
          const rank = order.indexOf(i);
          const touched = ev.frame === i;
          return (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 6px 8px", background: touched ? (ev.hit ? "var(--c3)" : "var(--c4)") : "var(--subtle)", color: touched ? "#fff" : "var(--fg)", transition: "background 0.2s", minWidth: 0 }}>
              <div style={{ fontSize: 11, opacity: 0.8 }}>frame {i}</div>
              <div style={{ fontSize: 22, fontWeight: 600, ...mono }}>{f.page < 0 ? "–" : `P${f.page}`}</div>
              <div style={{ fontSize: 11.5, ...mono }}>pins {f.pins}{f.dirty ? " · dirty" : ""}</div>
              <div style={{ fontSize: 11, opacity: 0.85, ...mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.page < 0 ? "empty" : pool.policy.tag(i)}</div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>{f.page < 0 ? "" : f.pins > 0 ? "pinned: safe" : rank === 0 ? "next victim" : `victim #${rank + 1}`}</div>
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 13, margin: "10px 0 0", minHeight: 36, color: ev.warn ? "var(--c4)" : "var(--fg)" }}>{ev.text}</p>
      <Stats items={[
        { label: "page table", value: <span style={{ fontSize: 13, ...mono }}>{[...pool.table].sort((a, b) => a[0] - b[0]).map(([pg, f]) => `P${pg}→${f}`).join(" ") || "empty"}</span> },
        { label: "hits / misses", value: `${pool.stats.hits} / ${pool.stats.misses}` },
        { label: "disk reads", value: pool.stats.reads },
        { label: "disk writes", value: pool.stats.writes },
      ]} />
    </Demo>
  );
}

// ---------------- policy race ----------------

const RACE_POLICIES: PolicyId[] = ["lru", "clock", "lru2", "2q", "midpoint", "pg"];
const RACE_COLORS: Record<PolicyId, string> = { lru: "var(--fg)", clock: "var(--faint)", lru2: "var(--c5)", "2q": "var(--c2)", midpoint: "var(--c4)", pg: "var(--c1)" };
const POOL_SIZES = [25, 50, 75, 100, 125, 150, 175, 200, 225, 250];
export const RACE_HOT = 100;

export function PolicyRaceDemo() {
  const p = useParams("race", {
    frames: range({ label: "Buffer pool size (frames)", min: 25, max: 250, step: 25, default: 150 }),
    scan: seg("Pages per scan", [["0", "No scans"], ["200", "200"], ["400", "400"], ["1600", "1,600"]], "400"),
    touches: seg("Rows read per scanned page", [["1", "1"], ["4", "4"]], "4"),
    window: toggle({ label: "Ignore repeat accesses within 50 accesses (old_blocks_time, LRU-2 correlation period)", default: false }),
  });
  const v = p.values;
  const trace = useMemo(() => mixedTrace({ hot: RACE_HOT, hotAccesses: 20000, scanPages: Number(v.scan), scanEvery: 1000, touches: Number(v.touches), coldFrac: 0.1, coldPages: 5000 }), [v.scan, v.touches]);
  const opts = v.window ? { oldTime: 50, crp: 50 } : { oldTime: 0, crp: 0 };
  const jobs = RACE_POLICIES.flatMap((pol) => POOL_SIZES.map((n) => () => runTrace(trace, n, pol, opts).hotHitRate));
  const res = useChunked(`race:${v.scan}:${v.touches}:${v.window}`, jobs);
  const at = (pol: PolicyId, n: number) => res[RACE_POLICIES.indexOf(pol) * POOL_SIZES.length + POOL_SIZES.indexOf(n)];
  const done = res.filter((x) => x !== undefined).length;
  return (
    <Demo
      title="Hot pages vs a scan: which policy keeps the hot set?"
      controls={<>
        <Param spec={p.schema.frames} value={v.frames} onChange={(x) => p.set("frames", x as number)} />
        <Param spec={p.schema.scan} value={v.scan} onChange={(x) => p.set("scan", x as string)} />
        <Param spec={p.schema.touches} value={v.touches} onChange={(x) => p.set("touches", x as string)} />
        <Param spec={p.schema.window} value={v.window} onChange={(x) => p.set("window", x as boolean)} />
      </>}
    >
      <SmallLabel>{RACE_HOT} hot pages take 90% of the lookups, 5,000 cold pages take 10%. After every 1,000 lookups, a scan reads pages that nobody reads again. {done < jobs.length ? `Computing… ${done} of ${jobs.length}` : ""}</SmallLabel>
      <Plot x={[25, 250]} y={[0, 1]} height={250} xLabel="frames in the pool" yLabel="hit rate of hot-page lookups" yFormat={(y) => `${Math.round(y * 100)}%`} xTicks={[50, 100, 150, 200, 250]}>
        {RACE_POLICIES.map((pol) => {
          const pts = POOL_SIZES.map((n) => [n, at(pol, n)] as const).filter((x): x is readonly [number, number] => x[1] !== undefined);
          return <Line key={pol} points={pts} color={RACE_COLORS[pol]} width={pol === "lru" ? 2.5 : 2} dash={pol === "clock" ? "4 3" : undefined} />;
        })}
        <RuleX at={RACE_HOT} label="hot set" />
        <RuleX at={v.frames} color="var(--fg)" />
      </Plot>
      <Legend items={RACE_POLICIES.map((pol) => ({ label: POLICY_LABEL[pol], color: RACE_COLORS[pol] }))} />
      <Stats items={RACE_POLICIES.map((pol) => ({ label: POLICY_LABEL[pol].replace(" (PostgreSQL)", "").replace(" (InnoDB)", ""), value: at(pol, v.frames) === undefined ? "…" : pct(at(pol, v.frames)!, 1) }))} />
    </Demo>
  );
}

// =====================================================================================
// Lesson 5: Durability
// =====================================================================================

const opText = (op: StackOp) => {
  switch (op.kind) {
    case "write": return `write(${op.key.replace("#", " block ")}, ${op.value})`;
    case "fsync": return `fsync(${op.file})`;
    case "fsyncdir": return "fsync(directory)";
    case "create": return `create ${op.file}`;
    case "rename": return `rename(${op.from}, ${op.to})`;
    case "writeback": return "kernel writeback (background)";
    case "io-error": return `disk fails on ${op.key.replace("#", " block ")}`;
    case "panic": return "database: PANIC";
  }
};

export function WriteStackDemo() {
  const p = useParams("wstack", {
    scenario: select({ label: "Program", options: SCENARIOS.map((s) => ({ value: s.id, label: s.label })), default: "fsync" }),
    dev: seg<DeviceCache>("Drive cache", [["flush", "Honours FLUSH"], ["lies", "Ignores FLUSH"], ["plp", "Power-loss protection"]], "flush"),
  });
  const sc = SCENARIOS.find((s) => s.id === p.values.scenario)!;
  const run = useMemo(() => runScenario(sc, p.values.dev), [sc, p.values.dev]);
  const n = sc.ops.length;
  const [crashRaw, setCrash] = useState(0);
  const k = Math.min(crashRaw, n);
  const fr = run.frames[k]!;
  const after = visible(fr.media);
  const lost = lostOnCrash(fr);
  const keys = run.keys;
  const cell = (m: Map<string, string>, key: string, dirty?: Set<string>) => {
    const val = m.get(key);
    if (val === undefined) return <span className="muted">–</span>;
    return <span style={{ color: dirty?.has(key) ? "var(--c2)" : "var(--fg)", fontWeight: dirty?.has(key) ? 600 : 400 }}>{val}{dirty?.has(key) ? " dirty" : ""}</span>;
  };
  const files = [...new Set([...after.keys(), ...[...fr.believed.keys()].filter((x) => !x.startsWith("dir:"))])].sort();
  return (
    <Demo
      title="From write() to the platter: pull the plug at any step"
      controls={<>
        <Param spec={range({ label: "Pull the plug after step", min: 0, max: n, step: 1, default: 0 })} value={k} onChange={(x) => setCrash(x as number)} />
        <Param spec={p.schema.scenario} value={p.values.scenario} onChange={(x) => { p.set("scenario", x as string); setCrash(0); }} />
        <Param spec={p.schema.dev} value={p.values.dev} onChange={(x) => p.set("dev", x as DeviceCache)} />
      </>}
    >
      <ol style={{ margin: "0 0 10px", paddingLeft: 22, fontSize: 13, ...mono }}>
        {sc.ops.map((op, i) => {
          const r = run.frames[i + 1]!.result!;
          return (
            <li key={i} style={{ color: i < k ? "var(--fg)" : "var(--faint)", margin: "2px 0" }}>
              {opText(op)}
              {i < k && r.ret && <b style={{ marginLeft: 8, color: r.ret === "ok" ? "var(--c3)" : "var(--c4)" }}>→ {r.ret}</b>}
              {i === k - 1 && <span style={{ marginLeft: 8, color: "var(--c4)" }}>⚡ power lost here</span>}
            </li>
          );
        })}
        {k === 0 && <li style={{ listStyle: "none", color: "var(--c4)" }}>⚡ power lost before step 1</li>}
      </ol>
      {k > 0 && <p style={{ fontSize: 12.5, margin: "0 0 10px" }} className="muted">Step {k}: {run.frames[k]!.result!.note}</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, ...mono }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th style={{ padding: "4px 6px" }}>block</th><th style={{ padding: "4px 6px" }}>page cache (RAM)</th><th style={{ padding: "4px 6px" }}>drive cache</th><th style={{ padding: "4px 6px" }}>stable media</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "4px 6px" }}>{key.replace("#", " block ").replace("dir:", "dir entry ")}</td>
                <td style={{ padding: "4px 6px" }}>{cell(fr.cache, key, fr.dirty)}</td>
                <td style={{ padding: "4px 6px" }}>{cell(fr.device, key)}</td>
                <td style={{ padding: "4px 6px" }}>{cell(fr.media, key)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: 13 }}>
        <b>After the reboot, a reader sees: </b>
        <span style={mono}>{files.length ? files.map((f) => `${f.replace("#", " block ")} = ${after.get(f) ?? "missing"}`).join(", ") : "nothing"}</span>
      </div>
      <p style={{ fontSize: 13, margin: "6px 0 0", color: lost.length ? "var(--c4)" : "var(--c3)" }}>
        {lost.length ? `Lost: the program was told that ${lost.map((x) => x.replace("#", " block ")).join(", ")} ${lost.length > 1 ? "were" : "was"} durable, but the disk has older data or nothing.` : "Nothing that the program was told is durable was lost."}
      </p>
    </Demo>
  );
}

// ---------------- torn pages ----------------

const LAYOUTS: Record<string, { page: number; sector: number }> = {
  "8k4k": { page: 8192, sector: 4096 },
  "16k4k": { page: 16384, sector: 4096 },
  "8k512": { page: 8192, sector: 512 },
};
const OUTCOME_COLOR: Record<Outcome, string> = { "ok-new": "var(--c3)", "ok-old": "var(--c3)", detected: "var(--c2)", silent: "var(--c4)" };

export function TornPageDemo() {
  const p = useParams("torn", {
    prot: seg<Protection>("Protection", [["none", "None"], ["checksum", "Checksum"], ["doublewrite", "Doublewrite"], ["fpw", "Full-page writes"]], "none"),
    layout: seg("Page / atomic write unit", [["8k4k", "8 KiB / 4 KiB"], ["16k4k", "16 KiB / 4 KiB"], ["8k512", "8 KiB / 512 B"]], "8k4k"),
    order: seg<SectorOrder>("Order the drive writes sectors", [["in-order", "In order"], ["reverse", "Reverse"], ["shuffled", "Any order"]], "in-order"),
  });
  const v = p.values;
  const L = LAYOUTS[v.layout]!;
  const sectors = L.page / L.sector;
  const steps = useMemo(() => tornUpdate(v.prot, sectors, v.order), [v.prot, sectors, v.order]);
  const [kRaw, setK] = useState(2);
  const k = Math.min(kRaw, steps.length);
  const rec = crashRecover(v.prot, steps, k, sectors);
  const all = useMemo(() => Array.from({ length: steps.length + 1 }, (_, j) => crashRecover(v.prot, steps, j, sectors).outcome), [v.prot, steps, sectors]);
  const pb = pageBytes(rec.state.page, L.sector);
  const label = (s: (typeof steps)[number]) =>
    s.kind === "wal" ? (s.fpi ? "WAL + page image" : "WAL record") : s.kind === "dw" ? `DW ${s.sector}` : s.kind === "dw-sync" ? "fsync DW" : s.kind === "page" ? `S${s.sector}` : "fsync";
  const sectorBox = (ver: number | null, key: string | number, small: boolean) => (
    <div key={key} style={{ flex: small ? "0 0 14px" : "1 1 0", minWidth: small ? 14 : 30, height: 26, borderRadius: 3, background: ver === null ? "var(--subtle)" : ver === 2 ? "var(--c3)" : "var(--c5)", border: "1px solid var(--border)", color: "#fff", fontSize: 10.5, display: "grid", placeItems: "center" }}>{small || ver === null ? "" : `v${ver}`}</div>
  );
  const small = sectors > 8;
  return (
    <Demo
      title="Pull the plug in the middle of a page write"
      controls={<>
        <Param spec={range({ label: "Pull the plug after step", min: 0, max: steps.length, step: 1, default: 2 })} value={k} onChange={(x) => setK(x as number)} />
        <Param spec={p.schema.prot} value={v.prot} onChange={(x) => p.set("prot", x as Protection)} />
        <Param spec={p.schema.layout} value={v.layout} onChange={(x) => p.set("layout", x as string)} />
        <Param spec={p.schema.order} value={v.order} onChange={(x) => p.set("order", x as SectorOrder)} />
      </>}
    >
      <SmallLabel>{PROTECTION_LABEL[v.prot]}: the steps of one page update (v1 → v2). Colour = what recovery finds if the power fails after that step.</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 10 }}>
        <span title="crash before step 1" style={{ ...chip, background: OUTCOME_COLOR[all[0]!], outline: k === 0 ? "2px solid var(--fg)" : undefined }}>start</span>
        {steps.map((s, j) => (
          <span key={j} style={{ ...chip, background: OUTCOME_COLOR[all[j + 1]!], outline: k === j + 1 ? "2px solid var(--fg)" : undefined, opacity: j < k ? 1 : 0.55 }} onClick={() => setK(j + 1)}>{label(s)}</span>
        ))}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <SmallLabel>WAL on disk</SmallLabel>
          <div style={{ ...chip, display: "inline-block", background: rec.state.walDurable ? "var(--c1)" : "var(--subtle)", color: rec.state.walDurable ? "#fff" : "var(--muted)" }}>{rec.state.walDurable ? (rec.state.walFpi ? `change + full image of the page (${bytes(L.page)})` : "change record only (about 100 B)") : "nothing for this change yet"}</div>
        </div>
        {v.prot === "doublewrite" && (
          <div>
            <SmallLabel>Doublewrite area {rec.state.dwSynced ? "(synced)" : ""}</SmallLabel>
            <div style={{ display: "flex", gap: 2 }}>{Array.from({ length: sectors }, (_, i) => sectorBox(i < rec.state.dw ? 2 : null, i, small))}</div>
          </div>
        )}
        <div>
          <SmallLabel>The page in the data file: {sectors} sectors of {bytes(L.sector)}</SmallLabel>
          <div style={{ display: "flex", gap: 2 }}>{rec.state.page.map((ver, i) => sectorBox(ver, i, small))}</div>
        </div>
      </div>
      <div style={{ ...mono, fontSize: 12, marginTop: 8 }}>
        CRC-32C stored in the header: {hex32(pb.stored)} · computed over the page: <span style={{ color: pb.stored === pb.computed ? "var(--c3)" : "var(--c4)" }}>{hex32(pb.computed)}</span>{v.prot === "none" ? " (not checked: no checksums)" : ""}
      </div>
      <ul style={{ fontSize: 13, margin: "10px 0 0", paddingLeft: 20 }}>{rec.actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
      <p style={{ fontSize: 13.5, margin: "8px 0 0", fontWeight: 600, color: OUTCOME_COLOR[rec.outcome] }}>{OUTCOME_LABEL[rec.outcome]}</p>
      <div style={{ marginTop: 8 }}><Legend items={[{ label: "v1 sector", color: "var(--c5)" }, { label: "v2 sector", color: "var(--c3)" }, { label: "recovers correctly", color: "var(--c3)" }, { label: "error detected", color: "var(--c2)" }, { label: "silent corruption", color: "var(--c4)" }]} /></div>
    </Demo>
  );
}

const chip = { padding: "3px 7px", borderRadius: 4, fontSize: 11.5, color: "#fff", cursor: "pointer", fontFamily: "ui-monospace, Menlo, monospace" } as const;

// ---------------- cost of protection ----------------

const UPD = Array.from({ length: 41 }, (_, i) => Math.pow(10, 3 + (i * 4) / 40));

export function ProtectionCostDemo() {
  const p = useParams("fpwcost", {
    table: range({ label: "Table size (8 KiB pages)", min: 1e3, max: 1e6, log: true, default: 1e5, format: (x) => `${sig(x, 2)} (${bytes(x * 8192)})` }),
    upd: range({ label: "Updates between checkpoints", min: 1e3, max: 1e7, log: true, default: 1e5, format: (x) => sig(x, 2) }),
  });
  const P = p.values.table, N = p.values.upd;
  const cur = checkpointCost({ tablePages: P, updates: N, recordBytes: 100, pageBytes: 8192 });
  const curve = useMemo(() => UPD.map((u) => ({ u, c: checkpointCost({ tablePages: P, updates: u, recordBytes: 100, pageBytes: 8192 }) })), [P]);
  return (
    <Demo title="What torn-page protection costs: bytes written per 100-byte update" controls={<><Param spec={p.schema.table} value={P} onChange={(x) => p.set("table", x as number)} /><Param spec={p.schema.upd} value={N} onChange={(x) => p.set("upd", x as number)} /></>}>
      <Plot x={[1e3, 1e7]} y={[50, 3e4]} logX logY height={240} xLabel="updates between checkpoints" yLabel="bytes written per update" xTicks={[1e3, 1e4, 1e5, 1e6, 1e7]} xFormat={(x) => sig(x, 1)} yTicks={[100, 1000, 1e4]} yFormat={(x) => sig(x, 1)}>
        <Line points={curve.map((x) => [x.u, x.c.perUpdate.plain] as const)} color="var(--c3)" />
        <Line points={curve.map((x) => [x.u, x.c.perUpdate.fpw] as const)} color="var(--c1)" />
        <Line points={curve.map((x) => [x.u, x.c.perUpdate.doublewrite] as const)} color="var(--c4)" dash="5 4" />
        <RuleX at={N} />
        <RuleX at={P} label="= table pages" color="var(--faint)" />
      </Plot>
      <Legend items={[{ label: "no protection (WAL + page flushes)", color: "var(--c3)" }, { label: "full-page writes", color: "var(--c1)" }, { label: "doublewrite (dashed): the same total", color: "var(--c4)" }]} />
      <Stats items={[
        { label: "distinct pages changed", value: sig(cur.distinct, 3) },
        { label: "WAL, no images", value: bytes(cur.walPlain) },
        { label: "WAL with full-page images", value: bytes(cur.walFpw) },
        { label: "WAL growth from images", value: `${sig(cur.walFpw / cur.walPlain, 3)}×` },
        { label: "bytes per update: none / FPW / doublewrite", value: `${sig(cur.perUpdate.plain, 3)} / ${sig(cur.perUpdate.fpw, 3)} / ${sig(cur.perUpdate.doublewrite, 3)}` },
      ]} />
      <Note>Full-page writes add each changed page to the WAL once per checkpoint. Doublewrite writes each flushed page twice. Both double the bytes when each page changes only once.</Note>
    </Demo>
  );
}

// =====================================================================================
// Lesson 6: Amplification
// =====================================================================================

const FAMILY_COLOR: Record<FamilyId, string> = { btree: "var(--c1)", leveled: "var(--c3)", tiered: "var(--c2)", loghash: "var(--c5)", sorted: "var(--muted)", logscan: "var(--c4)" };
const TRI = { R: [160, 18] as const, U: [18, 262] as const, M: [302, 262] as const };

export function RumTriangleDemo() {
  const p = useParams("rum", {
    rec: range({ label: "Record size", min: 16, max: 4096, log: true, default: 100, format: (x) => bytes(Math.round(x)) }),
    data: seg("Data set", [["1e10", "10 GB"], ["1e11", "100 GB"], ["1e12", "1 TB"]], "1e11"),
  });
  const env = { ...AMP_ENV, recordBytes: Math.round(p.values.rec), datasetBytes: Number(p.values.data) };
  const designs = useMemo(() => designSpace(env).map((d) => {
    const [r, u, m] = rumWeights(d.amp);
    return { ...d, x: r * TRI.R[0] + u * TRI.U[0] + m * TRI.M[0], y: r * TRI.R[1] + u * TRI.U[1] + m * TRI.M[1] };
  }), [env.recordBytes, env.datasetBytes]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sel, setSel] = useState(0);
  const svg = useRef<SVGSVGElement>(null);
  const pick = (e: RPointerEvent<SVGSVGElement>) => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 320, y = ((e.clientY - r.top) / r.height) * 280;
    let best = 0, bd = Infinity;
    designs.forEach((d, i) => { const dd = (d.x - x) ** 2 + (d.y - y) ** 2; if (dd < bd) { bd = dd; best = i; } });
    setSel(best);
  };
  const d = designs[Math.min(sel, designs.length - 1)]!;
  const fams = [...new Set(designs.map((x) => x.family))];
  return (
    <Demo title="The RUM triangle: drag to pick a design" controls={<><Param spec={p.schema.rec} value={p.values.rec} onChange={(x) => p.set("rec", x as number)} /><Param spec={p.schema.data} value={p.values.data} onChange={(x) => p.set("data", x as string)} /></>}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <svg ref={svg} viewBox="0 0 320 280" style={{ flex: "1 1 260px", maxWidth: 420, minWidth: 0, touchAction: "none", cursor: "crosshair" }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e); }} onPointerMove={(e) => { if (e.buttons) pick(e); }}>
          <polygon points={`${TRI.R.join(",")} ${TRI.U.join(",")} ${TRI.M.join(",")}`} fill="var(--subtle)" stroke="var(--border)" />
          <text x={TRI.R[0]} y={TRI.R[1] - 6} textAnchor="middle" style={{ fontSize: 10.5, fill: "var(--muted)" }}>cheap reads</text>
          <text x={TRI.U[0]} y={TRI.U[1] + 13} textAnchor="start" style={{ fontSize: 10.5, fill: "var(--muted)" }}>cheap writes</text>
          <text x={TRI.M[0]} y={TRI.M[1] + 13} textAnchor="end" style={{ fontSize: 10.5, fill: "var(--muted)" }}>little space</text>
          {fams.map((f) => {
            const pts = designs.filter((x) => x.family === f);
            return <polyline key={f} points={pts.map((x) => `${x.x},${x.y}`).join(" ")} fill="none" stroke={FAMILY_COLOR[f]} strokeWidth={1.2} opacity={0.6} />;
          })}
          {designs.map((x, i) => <circle key={i} cx={x.x} cy={x.y} r={i === sel ? 6 : 3.2} fill={FAMILY_COLOR[x.family]} stroke={i === sel ? "var(--fg)" : "none"} strokeWidth={1.5} />)}
        </svg>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{FAMILY_LABEL[d.family]}</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{d.knob || "one design"}</div>
          <Meter label="Point lookup, I/Os" value={Math.log10(Math.max(1, d.amp.ra)) + 0.05} max={4} color="var(--c1)" text={sig(d.amp.ra, 3)} />
          <Meter label={`Range of ${env.rangeRecords} records, I/Os`} value={Math.log10(Math.max(1, d.amp.raRange)) + 0.05} max={4} color="var(--c1)" text={sig(d.amp.raRange, 3)} />
          <Meter label="Write amplification" value={Math.log10(Math.max(1, d.amp.wa)) + 0.05} max={4} color="var(--c2)" text={`${sig(d.amp.wa, 3)}×`} />
          <Meter label="Space amplification" value={d.amp.sa - 1 + 0.02} max={5} color="var(--c5)" text={`${sig(d.amp.sa, 3)}×`} />
          <div className="muted" style={{ fontSize: 11.5 }}>Read placement uses √(point × range) = {sig(readCost(d.amp), 3)} I/Os.</div>
        </div>
      </div>
      <div style={{ marginTop: 8 }}><Legend items={fams.map((f) => ({ label: FAMILY_LABEL[f], color: FAMILY_COLOR[f] }))} /></div>
    </Demo>
  );
}

// ---------------- WA chain and SSD life ----------------

const RATES = Array.from({ length: 31 }, (_, i) => Math.pow(10, -1 + (i * 3) / 30));

export function WaChainDemo() {
  const presets = useMemo(() => enginePresets(), []);
  const p = useParams("wachain", {
    rate: range({ label: "User data written", min: 0.1, max: 100, log: true, default: 1, format: (x) => `${sig(x, 2)} MB/s` }),
    engine: seg("Engine", presets.map((e) => [e.id, e.label] as [string, string]), "btree"),
    fs: range({ label: "File system factor (journal, metadata)", min: 1, max: 2, step: 0.05, default: 1.1, format: (x) => `${x.toFixed(2)}×` }),
    op: seg("SSD spare space", [["0.07", "7%"], ["0.28", "28%"]], "0.07"),
    pe: seg("NAND", [["1000", "QLC, 1,000 cycles"], ["3000", "TLC, 3,000 cycles"]], "3000"),
  });
  const v = p.values;
  const op = Number(v.op);
  const dev = useChunked(`devwa:${op}`, [() => deviceWa(op, "random"), () => deviceWa(op, "sequential")]);
  const devOf = (w: string) => (w === "random" ? dev[0] : dev[1]);
  const e = presets.find((x) => x.id === v.engine)!;
  const dWa = devOf(e.deviceWorkload);
  const c = dWa === undefined ? null : chain({ appWa: e.appWa, fsWa: v.fs, deviceWa: dWa, userMBps: v.rate, capacityGB: 1000, peCycles: Number(v.pe) });
  const box = (top: string, sub: string, color = "var(--subtle)", fg = "var(--fg)") => (
    <div style={{ background: color, color: fg, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", minWidth: 0, textAlign: "center" }}>
      <div style={{ fontWeight: 600, fontSize: 15, ...mono }}>{top}</div>
      <div style={{ fontSize: 11, opacity: 0.8 }}>{sub}</div>
    </div>
  );
  const op_ = <span className="muted" style={{ fontSize: 14 }}>×</span>;
  return (
    <Demo title="One user byte, many NAND bytes: a 1 TB SSD" controls={<>
      <Param spec={p.schema.rate} value={v.rate} onChange={(x) => p.set("rate", x as number)} />
      <Param spec={p.schema.engine} value={v.engine} onChange={(x) => p.set("engine", x as string)} />
      <Param spec={p.schema.fs} value={v.fs} onChange={(x) => p.set("fs", x as number)} />
      <Param spec={p.schema.op} value={v.op} onChange={(x) => p.set("op", x as string)} />
      <Param spec={p.schema.pe} value={v.pe} onChange={(x) => p.set("pe", x as string)} />
    </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr auto 1fr", alignItems: "center", gap: 4 }}>
        {box(`${sig(e.appWa, 3)}`, "engine")}{op_}
        {box(`${v.fs.toFixed(2)}`, "file system")}{op_}
        {box(dWa === undefined ? "…" : dWa.toFixed(2), "SSD (FTL)")}
        <span className="muted" style={{ fontSize: 14 }}>=</span>
        {box(c ? sig(c.total, 3) : "…", "NAND bytes per user byte", "var(--c4)", "#fff")}
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 10px" }}>The engine writes {e.note}, so the SSD sees a {e.deviceWorkload} write pattern.</p>
      <Plot x={[0.1, 100]} y={[0.01, 1000]} logX logY height={220} xLabel="user writes, MB/s" yLabel="SSD life, years" xTicks={[0.1, 1, 10, 100]} xFormat={(x) => String(x)} yTicks={[0.01, 0.1, 1, 10, 100, 1000]} yFormat={(x) => String(x)}>
        {presets.map((pr, i) => {
          const dw = devOf(pr.deviceWorkload);
          if (dw === undefined) return null;
          const pts = RATES.map((r) => [r, chain({ appWa: pr.appWa, fsWa: v.fs, deviceWa: dw, userMBps: r, capacityGB: 1000, peCycles: Number(v.pe) }).years] as const);
          return <Line key={pr.id} points={pts} color={["var(--c4)", "var(--c3)", "var(--c2)", "var(--c5)"][i]} width={pr.id === v.engine ? 3 : 1.5} />;
        })}
        <RuleX at={v.rate} />
        {c && <Dots points={[[v.rate, c.years]]} color="var(--fg)" r={4} />}
      </Plot>
      <Legend items={presets.map((pr, i) => ({ label: pr.label, color: ["var(--c4)", "var(--c3)", "var(--c2)", "var(--c5)"][i]! }))} />
      <Stats items={[
        { label: "NAND writes", value: c ? `${sig(c.nandMBps, 3)} MB/s` : "…" },
        { label: "NAND writes per day", value: c ? `${sig(c.nandTBPerDay, 3)} TB` : "…" },
        { label: "SSD life", value: c ? (c.years >= 1 ? `${sig(c.years, 3)} years` : `${sig(c.years * 365, 3)} days`) : "…" },
      ]} />
    </Demo>
  );
}
