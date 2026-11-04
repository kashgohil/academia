/** Demos for "device drivers": a toy device with registers, and a descriptor ring. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, range, toggle, useParams } from "../../kit";
import {
  DescRing, STATUS, recvActions, replayDescRing, replayDevice, sendActions, statusText,
  type DevAction, type RingAction, type SlotState,
} from "../../sims/os/io";
import { Banner } from "./SyncShared";
import { Panel, mono, seg, tint } from "./ProcessesUi";

// ---------------------------------------------------------------- toy device

const PAYLOAD = [...("LAB")].map((c) => c.charCodeAt(0));
const ch = (v: number) => (v >= 32 && v < 127 ? String.fromCharCode(v) : "·");

const DEV = {
  latency: range({ label: "Device busy time", min: 1, max: 6, step: 1, default: 3, format: (v) => `${v} ${v === 1 ? "cycle" : "cycles"}` }),
  mode: seg<"send" | "recv">("Direction", [["send", "Send 3 bytes"], ["recv", "Receive 3 bytes"]], "send"),
};

function Bit({ on, name, bad }: { on: boolean; name: string; bad?: boolean }) {
  return <span style={{ ...mono, fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border)", background: on ? (bad ? "var(--c4)" : "var(--c2)") : "var(--bg)", color: on ? "var(--bg)" : "var(--muted)" }}>{name}</span>;
}

function ByteRow({ want, got }: { want: number[]; got: number[] }) {
  const n = Math.max(want.length, got.length, 3);
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {Array.from({ length: n }, (_, i) => {
        const g = got[i];
        const bad = g !== undefined && g !== want[i];
        return <span key={i} style={{ ...mono, width: 26, textAlign: "center", padding: "3px 0", borderRadius: 4, fontSize: 14, border: `1px solid ${bad ? "var(--c4)" : "var(--border)"}`, background: g === undefined ? "var(--bg)" : bad ? tint("var(--c4)", 25) : tint("var(--c3)", 25) }}>{g === undefined ? "" : ch(g)}</span>;
      })}
    </div>
  );
}

export function IoToyDeviceDemo() {
  const p = useParams("io-dev", DEV);
  const { latency, mode } = p.values;
  const [actions, setActions] = useState<DevAction[]>([]);
  const { dev, nextByte } = useMemo(() => replayDevice(mode, latency, actions, PAYLOAD), [mode, latency, actions]);
  const add = (a: DevAction) => setActions((x) => [...x, a]);
  const result = mode === "send" ? dev.wire : dev.got;
  const correct = result.length === PAYLOAD.length && result.every((v, i) => v === PAYLOAD[i]) && dev.problems === 0;
  const wrong = result.some((v, i) => v !== PAYLOAD[i]) || result.length > PAYLOAD.length || dev.problems > 0;
  const log = dev.log.slice(-6);
  return (
    <Demo
      title="Drive the device by hand"
      actions={<button className="btn ghost" onClick={() => setActions([])}>Reset</button>}
      controls={
        <>
          <Param spec={DEV.latency} value={latency} onChange={(v) => { p.set("latency", v as number); setActions([]); }} />
          <Param spec={DEV.mode} value={mode} onChange={(v) => { p.set("mode", v as never); setActions([]); }} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <Panel title="STATUS" style={{ flex: "1 1 150px" }}>
          <div style={{ display: "flex", gap: 4 }}>
            <Bit on={!!(dev.status & STATUS.BUSY)} name="BUSY" />
            <Bit on={!!(dev.status & STATUS.DRDY)} name="DRDY" />
            <Bit on={!!(dev.status & STATUS.ERR)} name="ERR" bad />
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>The true value. A driver sees it only when it reads the register.</div>
        </Panel>
        <Panel title="DATA" style={{ flex: "0 1 72px" }}><div style={{ ...mono, fontSize: 20, textAlign: "center" }}>{ch(dev.data)}</div></Panel>
        <Panel title={`Bus cycles`} style={{ flex: "0 1 80px" }}><div style={{ ...mono, fontSize: 20, textAlign: "center" }}>{dev.cycle}</div></Panel>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10, alignItems: "center" }}>
        <div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>{mode === "send" ? "Wanted on the wire" : "Bytes the device will give"}</div>
          <ByteRow want={PAYLOAD} got={PAYLOAD} />
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>{mode === "send" ? "On the wire now" : "The driver got"}</div>
          <ByteRow want={PAYLOAD} got={result} />
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <button className="btn" onClick={() => add("status")}>Read STATUS</button>
        {mode === "send"
          ? <button className="btn" onClick={() => add("data")}>Write DATA = {ch(PAYLOAD[Math.min(nextByte, PAYLOAD.length - 1)]!)}</button>
          : <button className="btn" onClick={() => add("read")}>Read DATA</button>}
        <button className="btn" onClick={() => add("command")}>Write COMMAND = {mode === "send" ? "SEND" : "RECV"}</button>
        <button className="btn ghost" onClick={() => add("wait")}>Do nothing for 1 cycle</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10, fontSize: 12.5, alignItems: "center" }}>
        <span className="muted">Run a driver:</span>
        <button className="btn" onClick={() => setActions(mode === "send" ? sendActions(3, latency, "correct") : recvActions(3, latency, "correct"))}>Correct</button>
        <button className="btn" onClick={() => setActions(mode === "send" ? sendActions(3, latency, "no-wait") : recvActions(3, latency, "no-wait"))}>No wait</button>
        {mode === "send" && <button className="btn" onClick={() => setActions(sendActions(3, latency, "command-first"))}>Command first</button>}
      </div>
      <div style={{ ...mono, fontSize: 12, lineHeight: 1.5, minHeight: 112, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--subtle)" }}>
        {log.length === 0 && <span className="muted">No bus access yet. Current status: {statusText(dev.status)}.</span>}
        {log.map((e, i) => <div key={i} style={{ color: e.problem ? "var(--c4)" : "var(--fg)" }}>{String(e.cycle).padStart(3, " ")}: {e.text}</div>)}
      </div>
      {(correct || wrong) && (
        <Banner tone={correct ? "good" : "bad"}>
          {correct
            ? `All 3 bytes arrived, in order, in ${dev.cycle} bus cycles.`
            : `Data is wrong or lost: ${result.map(ch).join("") || "nothing yet"} instead of LAB. The protocol broke ${dev.problems} ${dev.problems === 1 ? "time" : "times"}.`}
        </Banner>
      )}
    </Demo>
  );
}

// ---------------------------------------------------------------- descriptor ring

const SLOT_COLOR: Record<SlotState, string> = { free: "var(--subtle)", posted: "var(--c2)", device: "var(--c1)", done: "var(--c3)" };
const SLOT_LABEL: Record<SlotState, string> = { free: "free", posted: "written, not published", device: "owned by the device", done: "done, not reaped" };

const RING = {
  size: seg<"4" | "8" | "16">("Ring size", [["4", "4"], ["8", "8"], ["16", "16"]], "8"),
  skip: toggle({ label: "Use writel_relaxed: no barrier before the doorbell", default: false }),
};

function RingSvg({ ring }: { ring: DescRing }) {
  const S = 300, c = S / 2, R = 92, r = 62;
  const n = ring.size;
  const seg = (i: number) => {
    const a0 = (i / n) * 2 * Math.PI - Math.PI / 2 + 0.018, a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2 - 0.018;
    const p = (rad: number, a: number) => `${(c + rad * Math.cos(a)).toFixed(1)} ${(c + rad * Math.sin(a)).toFixed(1)}`;
    return `M${p(r, a0)} L${p(R, a0)} A${R} ${R} 0 0 1 ${p(R, a1)} L${p(r, a1)} A${r} ${r} 0 0 0 ${p(r, a0)}Z`;
  };
  const mid = (i: number, rad: number) => {
    const a = ((i + 0.5) / n) * 2 * Math.PI - Math.PI / 2;
    return [c + rad * Math.cos(a), c + rad * Math.sin(a)] as const;
  };
  // Pointers point at the boundary before a slot.
  const pointer = (i: number, rad: number, label: string, color: string) => {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2;
    const x0 = c + (R + 2) * Math.cos(a), y0 = c + (R + 2) * Math.sin(a);
    const x1 = c + rad * Math.cos(a), y1 = c + rad * Math.sin(a);
    const lx = c + (rad + 4) * Math.cos(a), ly = c + (rad + 4) * Math.sin(a);
    return (
      <g key={label}>
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={color} strokeWidth={2} />
        <text x={lx} y={ly + 4} fontSize={11.5} fontWeight={600} fill={color} textAnchor={Math.cos(a) > 0.2 ? "start" : Math.cos(a) < -0.2 ? "end" : "middle"}>{label}</text>
      </g>
    );
  };
  return (
    <svg viewBox={`0 0 ${S} ${S}`} style={{ width: "100%", maxWidth: 300, display: "block", margin: "0 auto" }} role="img" aria-label="descriptor ring">
      {ring.slots.map((s, i) => {
        const [tx, ty] = mid(i, (R + r) / 2);
        return (
          <g key={i}>
            <path d={seg(i)} fill={SLOT_COLOR[s.state]} stroke="var(--border)" style={{ transition: "fill .15s" }} />
            <text x={tx} y={ty + 4} fontSize={n > 8 ? 9.5 : 12} textAnchor="middle" fill={s.state === "free" ? "var(--muted)" : "var(--bg)"} style={{ fontVariantNumeric: "tabular-nums" }}>{s.buf ?? ""}</text>
          </g>
        );
      })}
      {pointer(ring.clean, 136, "clean", "var(--c3)")}
      {pointer(ring.head, 122, "head", "var(--c1)")}
      {pointer(ring.tail, 108, "tail", "var(--c5)")}
      <text x={c} y={c - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">next write</text>
      <text x={c} y={c + 10} textAnchor="middle" fontSize={15} fill="var(--fg)" style={{ fontVariantNumeric: "tabular-nums" }}>slot {ring.next}</text>
    </svg>
  );
}

export function IoDescRingDemo() {
  const p = useParams("io-ring", RING);
  const size = Number(p.values.size);
  const [actions, setActions] = useState<RingAction[]>([]);
  const { ring, nextBuf } = useMemo(() => replayDescRing(size, actions), [size, actions]);
  const add = (a: RingAction) => setActions((x) => [...x, a]);
  const barrier = !p.values.skip;
  const script = (mk: () => RingAction[]) => setActions(mk());
  const fullScript = () => Array.from({ length: size }, (): RingAction => ({ a: "post" }));
  let tone: "good" | "bad" | "plain" = "plain";
  let msg = "The driver posts buffers, then rings the doorbell. Nothing moves until the doorbell.";
  if (ring.staleReads > 0) { tone = "bad"; msg = `The device read ${ring.staleReads} ${ring.staleReads === 1 ? "descriptor" : "descriptors"} before the CPU store became visible. It sent an old or empty address.`; }
  else if (ring.fullRejects > 0 && ring.isFull) { tone = "bad"; msg = `The ring is full with ${ring.capacity} buffers in ${ring.size} slots. A real driver stops its queue now and restarts it after the next reap.`; }
  else if (ring.isFull) { msg = `The ring is full with ${ring.capacity} buffers in ${ring.size} slots. The last slot stays empty, so that next == clean can only mean empty.`; }
  else if (ring.unpublished > 0) { msg = `${ring.unpublished} ${ring.unpublished === 1 ? "descriptor waits" : "descriptors wait"} for the doorbell. The device cannot see them.`; }
  else if (ring.deviceOwned > 0) { msg = `The device owns ${ring.deviceOwned} ${ring.deviceOwned === 1 ? "slot" : "slots"}. It works with no help from the CPU.`; }
  else if (!ring.nothingToReap) { msg = "The device is idle. Finished slots wait for the driver to reap them."; }
  else if (ring.posted > 0) { msg = "head == tail: the ring is empty. The device stops and waits for the next doorbell."; }
  return (
    <Demo
      title="A transmit descriptor ring"
      actions={<button className="btn ghost" onClick={() => setActions([])}>Reset</button>}
      controls={
        <>
          <Param spec={RING.size} value={p.values.size} onChange={(v) => { p.set("size", v as never); setActions([]); }} />
          <Param spec={RING.skip} value={p.values.skip} onChange={(v) => p.set("skip", v as boolean)} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}><RingSvg ring={ring} /></div>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>Driver</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            <button className="btn" onClick={() => add({ a: "post", barrier })}>Post buffer {nextBuf}</button>
            <button className="btn" onClick={() => add({ a: "doorbell", barrier })} disabled={ring.unpublished === 0}>Ring doorbell</button>
            <button className="btn" onClick={() => add({ a: "reap" })} disabled={ring.nothingToReap}>Reap one</button>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>Device</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            <button className="btn" onClick={() => add({ a: "device" })} disabled={ring.deviceIdle}>Send one</button>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>Scripts</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            <button className="btn" onClick={() => script(fullScript)}>Fill the ring</button>
            <button className="btn" onClick={() => script(() => [{ a: "post" }, { a: "post" }, { a: "doorbell" }, { a: "device" }, { a: "device" }, { a: "reap" }, { a: "reap" }])}>Run until empty</button>
          </div>
          <div style={{ display: "grid", gap: 2, fontSize: 12 }}>
            {(Object.keys(SLOT_COLOR) as SlotState[]).map((s) => (
              <div key={s} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 11, height: 11, borderRadius: 2, background: SLOT_COLOR[s], border: "1px solid var(--border)" }} />
                <span className="muted">{SLOT_LABEL[s]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <Banner tone={tone}>{msg}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "posted", value: ring.posted },
          { label: "doorbells", value: ring.doorbells },
          { label: "sent", value: ring.consumed },
          { label: "reaped", value: ring.reaped },
          { label: "rejected: ring full", value: ring.fullRejects },
        ]} />
      </div>
    </Demo>
  );
}
