/** Demos for the lesson on sequence CRDTs: two live editors that merge with RGA on Net, and the interleaving anomaly. */
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { Banner, Btn, Chip, Demo, MiniTable, Panel, Param, SectionLabel, SmallLabel, Stats, mono, pct, range, seg, useParams } from "../../kit";
import { SpaceTime, type StMessage } from "./SpaceTime";
import { RgaNet, idKey, interleave, logootSplitShare, type Direction, type Rga } from "../../sims/dist/crdts";

const NAMES = ["A", "B"];
const OWNER = ["var(--c1)", "var(--c5)"];
const idText = (key: string) => { const [c, r] = key.split("@"); return `${c}${NAMES[Number(r)] ?? "·"}`; };

// ============================================================================ 1. Two editors on Net

const ED = { delay: range({ label: "Network delay (one way)", min: 0, max: 3000, step: 100, default: 1200, format: (v) => `${v} ms` }) };

/** The visible index just after `anchor` (an element id, or "" for the start), counting only visible elements. */
function caretAfter(doc: Rga, anchor: string): number {
  if (!anchor) return 0;
  let n = 0;
  for (const e of doc.elems) {
    if (!e.deleted) n++;
    if (idKey(e.id) === anchor) return n;
  }
  return n;
}

function IdStrip({ doc }: { doc: Rga }) {
  const els = doc.elems;
  const shown = els.slice(-48);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 6 }}>
      {els.length > shown.length && <span className="muted" style={{ fontSize: 11 }}>… {els.length - shown.length} more</span>}
      {shown.map((e) => (
        <Chip key={idKey(e.id)} color={OWNER[e.id.r] ?? "var(--muted)"} strike={e.deleted} faint={e.deleted} title={`id ${idText(idKey(e.id))}, inserted after ${e.after ? idText(e.after) : "the start"}`}>
          {`${e.ch === " " ? "␣" : e.ch === "\n" ? "↵" : e.ch} ${idText(idKey(e.id))}`}
        </Chip>
      ))}
    </div>
  );
}

export function CrdtEditorsDemo() {
  const P = useParams("crdt-editors", ED);
  const delay = P.values.delay;
  const [net, setNet] = useState(() => new RgaNet(2, 300, 1, 400));
  const [cut, setCut] = useState(false);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const t0 = useRef(performance.now());
  const areas = useRef<(HTMLTextAreaElement | null)[]>([null, null]);
  const anchors = useRef<(string | null)[]>([null, null]);
  const now = () => performance.now() - t0.current;

  useEffect(() => {
    let seen = -1;
    const id = window.setInterval(() => {
      // Remember where each focused caret is, as the id of the character to its left.
      anchors.current = net.docs.map((d, i) => {
        const ta = areas.current[i];
        if (!ta || document.activeElement !== ta) return null;
        const p = ta.selectionStart;
        return p > 0 ? idKey(d.visible()[p - 1]!.id) : "";
      });
      net.cb.net.runUntil(now());
      const n = net.cb.net.trace.length;
      if (n !== seen || net.pending() > 0) { seen = n; bump(); }
    }, 60);
    return () => window.clearInterval(id);
  }, [net]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    net.docs.forEach((d, i) => {
      const a = anchors.current[i], ta = areas.current[i];
      if (a === null || !ta || document.activeElement !== ta) return;
      const p = caretAfter(d, a ?? "");
      if (ta.selectionStart !== p) ta.setSelectionRange(p, p);
      anchors.current[i] = null;
    });
  });

  const edit = (i: number, text: string) => {
    net.cb.net.runUntil(now());
    net.edit(i, text, delay);
    anchors.current[i] = null;
    bump();
  };
  const toggleCut = () => {
    net.cb.net.runUntil(now());
    if (cut) net.cb.net.heal(); else net.cb.net.partition([[0], [1]]);
    setCut(!cut);
  };
  const reset = () => { t0.current = performance.now(); setCut(false); setNet(new RgaNet(2, 300, 1, 400)); };

  const tNow = net.cb.net.now;
  const tStart = Math.max(0, tNow - 6000);
  const messages: StMessage[] = net.cb.net.messages
    .filter((m) => m.sentAt >= tStart && (m.deliveredAt !== undefined || m.lost))
    .map((m) => ({
      from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost && m.lost !== "dropped" ? m.lostAt : undefined,
      color: m.payload.k === "sync" ? "var(--border)" : m.lost ? "var(--c4)" : OWNER[m.from],
    }));
  const inFlight = net.cb.net.messages.filter((m) => m.payload.k === "op" && m.deliveredAt === undefined && !m.lost).length;
  const texts = net.docs.map((d) => d.text());
  const same = texts[0] === texts[1];
  const pending = net.pending();
  const box: CSSProperties = { width: "100%", boxSizing: "border-box", fontFamily: "ui-monospace, monospace", fontSize: 14, padding: 6, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", resize: "vertical" };
  return (
    <Demo
      title="Two editors, one RGA, a slow network"
      actions={<>
        <Btn onClick={toggleCut} on={cut}>{cut ? "Heal the partition" : "Cut the network"}</Btn>
        <Btn ghost onClick={reset}>Reset</Btn>
      </>}
      controls={<Param spec={ED.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />}
    >
      <SmallLabel>Type in both boxes, also at the same place. Each keystroke is an op that reaches the other editor after the delay. While the network is cut, ops are lost; anti-entropy sends them again after the heal.</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
        {net.docs.map((d, i) => (
          <Panel key={i} title={`Editor ${NAMES[i]}`} accent={OWNER[i]}>
            <textarea ref={(el) => { areas.current[i] = el; }} rows={3} value={texts[i]} spellCheck={false} placeholder={`Type here as ${NAMES[i]}`} onChange={(e) => edit(i, e.target.value)} style={box} aria-label={`editor ${NAMES[i]}`} />
            <IdStrip doc={d} />
          </Panel>
        ))}
      </div>
      <SpaceTime nodes={["A", "B"]} tStart={tStart} tEnd={Math.max(tStart + 1000, tNow)} messages={messages} rowHeight={36} />
      <Banner tone={same ? "good" : cut ? "bad" : "warn"}>
        {same
          ? `Both editors show the same text, and the same list of ${net.docs[0]!.elems.length} ids (with tombstones). Concurrent inserts at one place are ordered by id, newest first.`
          : cut
            ? "The network is cut. Each editor keeps working on its own copy. Heal it to merge."
            : `${inFlight} ops are on their way. The texts differ until they arrive.`}
      </Banner>
      <Stats items={[
        { label: "characters (with tombstones)", value: `${net.docs[0]!.visible().length} (${net.docs[0]!.elems.length})` },
        { label: "ops in flight", value: inFlight },
        { label: "ops not yet applied somewhere", value: pending },
      ]} />
    </Demo>
  );
}

// ============================================================================ 2. Interleaving

const IL = {
  dir: seg<Direction>("How the users type", [["forward", "left to right"], ["backward", "right to left"]], "forward"),
  words: seg<"cd" | "me">("Words", [["cd", "cat / dog"], ["me", "milk / eggs"]], "cd"),
  seed: range({ label: "Logoot run (random digits)", min: 1, max: 20, step: 1, default: 1 }),
};
const WORDS = { cd: ["cat", "dog"], me: ["milk", "eggs"] } as const;

function Colored({ text, owners }: { text: string; owners: number[] }) {
  return (
    <span style={{ fontSize: 18, letterSpacing: 1, ...mono }}>
      {[...text].map((ch, i) => <span key={i} style={{ color: owners[i]! < 0 ? "var(--fg)" : OWNER[owners[i]!], fontWeight: owners[i]! < 0 ? 400 : 700 }}>{ch === " " ? " " : ch}</span>)}
    </span>
  );
}

export function CrdtInterleaveDemo() {
  const P = useParams("crdt-interleave", IL);
  const { dir, words, seed } = P.values;
  const [a, b] = WORDS[words];
  const res = useMemo(() => (["index", "logoot", "rga"] as const).map((algo) => interleave(algo, a, b, dir, "Hi !", 3, seed)), [a, b, dir, seed]);
  const share = useMemo(() => logootSplitShare(a, b, dir), [a, b, dir]);
  const [idx, logoot, rga] = res as [ReturnType<typeof interleave>, ReturnType<typeof interleave>, ReturnType<typeof interleave>];
  const verdict = (r: ReturnType<typeof interleave>) => (!r.converged ? "diverged" : r.wordsKept ? "words kept whole" : "interleaved");
  return (
    <Demo title="Two users type a word at the same place" controls={<>{(["dir", "words", "seed"] as const).map((k) => <Param key={k} spec={IL[k]} value={P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}>
      <SmallLabel>The text is "Hi !". At the same time, user A types "{a}" and user B types "{b}" just before the "!". Then each side applies the other's ops.</SmallLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Panel title={`Index-based ops, no CRDT: ${verdict(idx)}`} accent={idx.converged ? "var(--c3)" : "var(--c4)"}>
          <div style={{ fontSize: 18, ...mono }}>A: <Colored text={idx.texts[0]} owners={idx.owners} /></div>
          <div style={{ fontSize: 18, ...mono }}>B: {idx.texts[1]}</div>
        </Panel>
        <Panel title={`Logoot-style positions: ${verdict(logoot)}`} accent={logoot.wordsKept ? "var(--c3)" : "var(--c4)"}>
          <Colored text={logoot.texts[0]} owners={logoot.owners} />
        </Panel>
        <Panel title={`RGA: ${verdict(rga)}`} accent={rga.wordsKept ? "var(--c3)" : "var(--c4)"}>
          <Colored text={rga.texts[0]} owners={rga.owners} />
          <SectionLabel>Merged list: character, id, and the id it was inserted after (· marks the starting text)</SectionLabel>
          <MiniTable
            head={["char", "id", "after"]}
            rows={(rga.rga ?? []).filter((e) => e.owner >= 0 || e.ch === " " || e.ch === "!").map((e) => [
              <span key="c" style={{ color: e.owner < 0 ? "var(--fg)" : OWNER[e.owner], ...mono }}>{e.ch === " " ? "␣" : e.ch}</span>,
              <span key="i" style={mono}>{idText(e.id)}</span>,
              <span key="a" style={mono}>{e.after ? idText(e.after) : "start"}</span>,
            ])}
          />
        </Panel>
      </div>
      <Banner tone={rga.wordsKept ? "good" : "bad"}>
        {dir === "forward"
          ? `RGA keeps both words whole. Each letter is inserted after the previous letter, so a word forms a chain, and the skip rule moves whole chains. Logoot-style positions split a word in ${pct(share, 1)} of 200 runs.`
          : `Typed right to left, every letter is inserted after the same character, the space. All ${a.length + b.length} letters are siblings of the space, sorted by id with the newest first, so the letters of A and B alternate. RGA interleaves too. Logoot-style positions split a word in ${pct(share, 1)} of 200 runs.`}
      </Banner>
    </Demo>
  );
}

