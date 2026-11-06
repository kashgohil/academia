/** Demos for the lesson on sets, maps and deletion: a set playground with three semantics, and tombstone growth with GC. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Legend, Line, Panel, Param, Plot, RuleX, SectionLabel, SmallLabel, Stats, mono, range, toggle, useParams } from "../../kit";
import { SET_PRESETS, lwwSet, orLiveTags, orSet, playSet, runTombstones, twoPSet, type LwwSet, type OrSet, type SetAction, type TwoP } from "../../sims/dist/crdts";

const R = ["R1", "R2"];

// ============================================================================ 1. The set playground

const PLAY = { skew: range({ label: "R2 clock offset (for LWW)", min: -50, max: 50, step: 5, default: 0, format: (v) => `${v > 0 ? "+" : ""}${v} ms` }) };

const fmtT = (t: number) => (t === -Infinity ? "–" : String(Math.round(t)));
const setText = (xs: string[]) => (xs.length ? `{${xs.join(", ")}}` : "∅");

function explain2P(s: TwoP, e: string): string {
  if (!s.a.includes(e)) return `${e} was never added.`;
  if (s.r.includes(e)) return `${e} is in the remove set R, a tombstone. A 2P-Set lets no add bring it back.`;
  return `${e} is in A and not in R.`;
}
function explainLww(s: LwwSet, e: string): string {
  const v = s[e];
  if (!v) return `${e} was never added.`;
  const [a, d] = v;
  if (d === -Infinity) return `Added at ${fmtT(a)}; never removed.`;
  return `Last add at ${fmtT(a)}, last remove at ${fmtT(d)}: the ${a >= d ? "add" : "remove"} has the later clock, so it wins.`;
}
function explainOr(s: OrSet, e: string): string {
  const all = Object.keys(s.adds).filter((t) => s.adds[t] === e);
  if (!all.length) return `${e} was never added.`;
  const live = orLiveTags(s, e);
  const dead = all.filter((t) => !live.includes(t));
  return live.length
    ? `Tag ${live.join(", ")} was not seen by any remove${dead.length ? `; ${dead.join(", ")} ${dead.length > 1 ? "are" : "is a"} tombstone${dead.length > 1 ? "s" : ""}` : ""}. So ${e} stays: add wins.`
    : `Every tag of ${e} (${dead.join(", ")}) was seen by a remove.`;
}

export function CrdtSetPlaygroundDemo() {
  const P = useParams("crdt-setplay", PLAY);
  const skew = P.values.skew;
  const [actions, setActions] = useState<SetAction[]>(SET_PRESETS[0]!.actions);
  const sk: [number, number] = [0, skew];
  const two = useMemo(() => playSet(twoPSet, actions, sk), [actions, skew]); // eslint-disable-line react-hooks/exhaustive-deps
  const lww = useMemo(() => playSet(lwwSet, actions, sk), [actions, skew]); // eslint-disable-line react-hooks/exhaustive-deps
  const or = useMemo(() => playSet(orSet, actions, sk), [actions, skew]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = [...new Set(actions.flatMap((a) => (a.k === "sync" ? [] : [a.e])))].sort();
  const push = (a: SetAction) => setActions((x) => [...x, a]);
  const cols = [
    { name: "2P-Set", res: two.merged, el: twoPSet.elements(two.merged), why: items.map((e) => explain2P(two.merged, e)), meta: `A ${setText(two.merged.a)}, R ${setText(two.merged.r)}` },
    { name: "LWW-element-Set", res: lww.merged, el: lwwSet.elements(lww.merged), why: items.map((e) => explainLww(lww.merged, e)), meta: Object.entries(lww.merged).map(([e, [a, d]]) => `${e}: add ${fmtT(a)}, rmv ${fmtT(d)}`).join("; ") || "empty" },
    { name: "OR-Set", res: or.merged, el: orSet.elements(or.merged), why: items.map((e) => explainOr(or.merged, e)), meta: `tags ${Object.entries(or.merged.adds).map(([t, e]) => `${e}:${t}`).join(" ") || "none"}; tombstones ${or.merged.tombs.join(" ") || "none"}` },
  ];
  const differ = new Set(cols.map((c) => JSON.stringify(c.el))).size > 1;
  return (
    <Demo
      title="The same ops, three set semantics"
      actions={<>
        <Btn onClick={() => setActions((a) => a.slice(0, -1))} disabled={!actions.length}>Undo</Btn>
        <Btn ghost onClick={() => setActions([])}>Clear</Btn>
      </>}
      controls={<Param spec={PLAY.skew} value={skew} onChange={(v) => P.set("skew", v as number)} />}
    >
      <ButtonRow>
        <span className="muted" style={{ fontSize: 12.5 }}>Presets:</span>
        {SET_PRESETS.map((p) => <Btn key={p.id} ghost onClick={() => setActions(p.actions)}>{p.name}</Btn>)}
      </ButtonRow>
      <SectionLabel>Ops, with the time on the replica clock</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minHeight: 20 }}>
        {actions.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>No ops yet.</span>}
        {actions.map((a, k) => (
          <Chip key={k} color={a.k === "sync" ? "var(--muted)" : a.k === "add" ? "var(--c3)" : "var(--c4)"} strike={a.k !== "sync" && two.ignored[k] && a.k === "rmv"}>
            {a.k === "sync" ? "sync" : `${R[a.r]} ${a.k === "add" ? "add" : "rmv"} ${a.e} @${10 * (k + 1) + (a.r === 1 ? skew : 0)}`}
          </Chip>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, marginTop: 8 }}>
        {R.map((name, r) => (
          <Panel key={r} title={name}>
            <ButtonRow>
              {(["x", "y"] as const).map((e) => <Btn key={`a${e}`} onClick={() => push({ k: "add", r, e })}>add {e}</Btn>)}
              {(["x", "y"] as const).map((e) => <Btn key={`r${e}`} onClick={() => push({ k: "rmv", r, e })}>rmv {e}</Btn>)}
            </ButtonRow>
          </Panel>
        ))}
      </div>
      <ButtonRow style={{ marginTop: 6 }}><Btn onClick={() => push({ k: "sync" })}>Sync R1 and R2</Btn></ButtonRow>
      <SectionLabel>After a final merge</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 6 }}>
        {cols.map((c) => (
          <Panel key={c.name} title={c.name} accent={c.el.length ? "var(--c3)" : "var(--c4)"}>
            <div style={{ fontSize: 18, fontWeight: 650, ...mono }}>{setText(c.el)}</div>
            <div className="muted" style={{ fontSize: 11, margin: "2px 0 4px", overflowWrap: "anywhere", ...mono }}>{c.meta}</div>
            {c.why.map((w, i) => <div key={i} style={{ fontSize: 12.5, lineHeight: 1.4 }}>{w}</div>)}
          </Panel>
        ))}
      </div>
      <Banner tone={differ ? "warn" : "plain"}>
        {differ
          ? "The three sets saw the same ops and disagree. Each one converges, but each answers the add/remove race in its own way."
          : "Here all three agree. Try a remove on one replica and an add of the same item on the other, with no sync between them."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Tombstones over time

const TOMB = {
  rate: range({ label: "Updates per second", min: 10, max: 100, step: 10, default: 50 }),
  cut: toggle({ label: "Cut R3 off from 1.0 s to 2.5 s", default: false }),
};

export function CrdtTombstoneDemo() {
  const P = useParams("crdt-tomb", TOMB);
  const { rate, cut } = P.values;
  const cfg = { rate, cut: cut ? ([1000, 2500] as [number, number]) : null };
  const runs = useMemo(() => (["keep", "gc", "orswot"] as const).map((m) => runTombstones(m, cfg)), [rate, cut]); // eslint-disable-line react-hooks/exhaustive-deps
  const [keep, gc, ow] = runs as [ReturnType<typeof runTombstones>, ReturnType<typeof runTombstones>, ReturnType<typeof runTombstones>];
  const yMax = Math.max(10, ...keep.samples.map((s) => s[1]), ...keep.samples.map((s) => s[2])) * 1.1;
  const gcPeak = Math.max(...gc.samples.map((s) => s[1]));
  return (
    <Demo title="Tombstones pile up unless someone collects them" controls={<>{(["rate", "cut"] as const).map((k) => <Param key={k} spec={TOMB[k]} value={P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}>
      <SmallLabel>Three replicas share a cart of 12 possible items and gossip full states every 40 ms over FIFO links. Updates stop at 3.2 s. The lines show metadata at R1.</SmallLabel>
      <Plot x={[0, 4000]} y={[0, yMax]} height={240} xLabel="time (ms)" yLabel="metadata items at R1">
        {cut && <RuleX at={1000} label="cut" />}
        {cut && <RuleX at={2500} label="heal" />}
        <Line points={keep.samples.map((s) => [s[0], s[2]] as const)} color="var(--muted)" dash="3 3" width={1.5} />
        <Line points={keep.samples.map((s) => [s[0], s[1]] as const)} color="var(--c4)" width={2.5} />
        <Line points={gc.samples.map((s) => [s[0], s[1]] as const)} color="var(--c1)" width={2.5} />
        <Line points={ow.samples.map((s) => [s[0], s[1]] as const)} color="var(--c3)" width={2.5} />
      </Plot>
      <Legend items={[
        { label: "OR-Set, tombstones kept", color: "var(--c4)" },
        { label: "OR-Set, GC at causal stability", color: "var(--c1)" },
        { label: "optimized OR-Set (vector entries)", color: "var(--c3)" },
        { label: "live elements", color: "var(--muted)" },
      ]} />
      <Banner tone={cut ? "warn" : "info"}>
        {cut
          ? `While R3 is cut off, R1 cannot learn that R3 has seen a remove, so no tombstone is stable. GC stalls and the tombstones grow to ${gcPeak}. After the heal, R3 catches up and they are collected.`
          : `Without GC, R1 ends with ${keep.finalMeta} tombstones for ${keep.removes} removes: one per removed tag, forever. GC keeps at most ${gcPeak}. The optimized set needs no tombstones, only its ${ow.finalMeta}-entry version vector.`}
      </Banner>
      <Stats items={[
        { label: "adds / removes", value: `${keep.adds} / ${keep.removes}` },
        { label: "tombstones kept, at the end", value: keep.finalMeta },
        { label: "with GC, peak", value: gcPeak },
        { label: "all converged", value: runs.every((r) => r.converged) ? "yes" : "no" },
      ]} />
    </Demo>
  );
}
