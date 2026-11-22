/** Lesson: static and dynamic linking. Archive order on the command line, and code models against output types. */
import { useState } from "react";
import { Banner, Chip, Demo, IndexButtons, IndexSlider, Note, Param, SectionLabel, SmallLabel, Stats, mono, seg, tint, toggle } from "../../kit";
import { LIBLOG, LIBZ, MAIN_OBJ, picOutcome, scanArchives, type CmdItem, type CodeModel, type DefsIn, type Output } from "../../sims/sys/linking";

const ITEM_COLOR: Record<string, string> = { "main.o": "var(--c1)", "libz.a": "var(--c3)", "liblog.a": "var(--c5)" };

export function ArchiveOrderDemo() {
  const [order, setOrder] = useState<CmdItem[]>([MAIN_OBJ, LIBZ, LIBLOG]);
  const [repeat, setRepeat] = useState(false);
  const [group, setGroup] = useState(false);
  const [mode, setMode] = useState<"gnu" | "lld">("gnu");
  const [k, setK] = useState(99);
  const items = repeat ? [...order, LIBZ] : order;
  const libIdx = items.map((it, i) => (it.kind === "lib" ? i : -1)).filter((i) => i >= 0);
  const grp: [number, number] | null = group && libIdx.length ? [Math.min(...libIdx), Math.max(...libIdx)] : null;
  const res = scanArchives(items, mode, grp);
  const n = res.events.length;
  const step = Math.min(k, n);
  const shown = res.events.slice(0, step);
  const cur = step > 0 ? res.events[step - 1]! : null;
  const extractedNow = new Set(shown.filter((e) => e.kind === "extract").map((e) => `${items[e.item]!.name}:${e.member}`));
  const done = step >= n;
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const o = [...order];
    [o[i], o[j]] = [o[j]!, o[i]!];
    setOrder(o);
    setK(99);
  };
  const cmd = items.map((it, i) => `${grp && i === grp[0] ? "--start-group " : ""}${it.name}${grp && i === grp[1] ? " --end-group" : ""}`).join(" ");
  return (
    <Demo
      title="Order the command line"
      actions={<IndexButtons k={step} n={n + 1} set={setK} />}
      controls={<>
        <IndexSlider k={step} n={n + 1} set={setK} label="Linker step" />
        <Param spec={seg("Linker rules", [["gnu", "GNU ld"], ["lld", "ld.lld"]], "gnu")} value={mode} onChange={(v) => { setMode(v as "gnu"); setK(99); }} />
        <Param spec={toggle({ label: "Repeat libz.a at the end", default: false })} value={repeat} onChange={(v) => { setRepeat(v as boolean); setK(99); }} />
        <Param spec={toggle({ label: "--start-group around the archives", default: false })} value={group} onChange={(v) => { setGroup(v as boolean); setK(99); }} />
      </>}
    >
      <SmallLabel>Move the inputs. The linker reads them from left to right.</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {items.map((it, i) => {
          const c = ITEM_COLOR[it.name]!;
          const active = cur?.item === i;
          return (
            <div key={i} style={{ border: `1.5px solid ${active ? "var(--fg)" : c}`, borderRadius: 6, padding: "4px 6px", minWidth: 120, flex: "1 1 120px", background: grp && i >= grp[0] && i <= grp[1] ? tint("var(--c2)", 10) : undefined }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                <b style={{ ...mono, fontSize: 12.5 }}>{it.name}</b>
                {i < order.length && (
                  <span>
                    <button className="btn ghost" style={{ padding: "0 6px" }} disabled={i === 0} onClick={() => move(i, -1)} aria-label="move left">‹</button>
                    <button className="btn ghost" style={{ padding: "0 6px" }} disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label="move right">›</button>
                  </span>
                )}
              </div>
              {it.members.map((m) => {
                const got = it.kind === "obj" || extractedNow.has(`${it.name}:${m.name}`);
                return (
                  <div key={m.name} style={{ ...mono, fontSize: 11, padding: "1px 4px", marginTop: 2, borderRadius: 3, background: got ? tint(c, 30) : undefined, opacity: got ? 1 : 0.6 }}>
                    {it.kind === "lib" && <span>{m.name}: </span>}
                    <span>{m.defines.join(", ")}</span>
                    {m.needs.length > 0 && <span className="muted"> needs {m.needs.join(", ")}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div style={{ ...mono, fontSize: 11.5, marginTop: 6, overflowX: "auto", whiteSpace: "nowrap" }} className="muted">{mode === "gnu" ? "ld" : "ld.lld --warn-backrefs"} {cmd}</div>
      <Stats items={[
        { label: "Members extracted", value: shown.filter((e) => e.kind === "extract").length },
        { label: "Undefined now", value: cur ? cur.undefined.join(", ") || "none" : "none" },
      ]} />
      <div style={{ ...mono, fontSize: 11.5, maxHeight: 150, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px" }}>
        {shown.length === 0 && <span className="muted">Press Next to start.</span>}
        {shown.map((e, j) => (
          <div key={j} style={{ color: e.kind === "warn" ? "var(--c2)" : e.kind === "extract" ? "var(--fg)" : "var(--muted)", fontWeight: j === step - 1 ? 600 : 400 }}>
            {items[e.item]!.name}: {e.text}
          </div>
        ))}
      </div>
      {done && (
        res.undefined.length
          ? <Banner tone="bad" label={mode === "gnu" ? "GNU ld" : "ld.lld"}><span style={mono}>{res.undefined.map((u) => `undefined reference to \`${u}'`).join("; ")}</span></Banner>
          : res.warnings.length
            ? <Banner tone="warn" label="ld.lld">Links, but with {res.warnings.length} warning{res.warnings.length > 1 ? "s" : ""}. GNU ld would fail on this command line.</Banner>
            : <Banner tone="good" label="ok">Every symbol is defined. {res.extracted.length} archive members are in the program; the others stay out.</Banner>
      )}
    </Demo>
  );
}

// ---------------------------------------------------------------------------- code model × output

const ACTION_COLOR: Record<string, string> = {
  direct: "var(--c3)", "direct jump": "var(--c3)", "relaxed to lea": "var(--c3)", "GOT slot": "var(--c2)", "PLT stub": "var(--c2)", "copy relocation": "var(--c5)", error: "var(--c4)",
};
const CM_LABEL: Record<CodeModel, string> = { "no-pic": "-fno-pic", pie: "-fPIE", pic: "-fPIC" };
const OUT_LABEL: Record<Output, string> = { exe: "executable (-no-pie)", pie: "PIE", shared: "shared library" };
export const PIC_SOURCE = `extern int counter;   // defined elsewhere
int hits;             // defined here
int add(int a, int b);
int get(void) { hits += 1; return add(counter, hits); }`;

export function PicMatrixDemo() {
  const [cm, setCm] = useState<CodeModel>("pie");
  const [out, setOut] = useState<Output>("shared");
  const [defs, setDefs] = useState<DefsIn>("same");
  const [bsym, setBsym] = useState(false);
  const r = picOutcome(cm, out, defs, bsym && out === "shared");
  const cms: CodeModel[] = ["no-pic", "pie", "pic"];
  const outs: Output[] = ["exe", "pie", "shared"];
  return (
    <Demo
      title="Compile one way, link another"
      controls={<>
        <Param spec={seg("Compile get.c with", [["no-pic", "-fno-pic"], ["pie", "-fPIE"], ["pic", "-fPIC"]], "pie")} value={cm} onChange={(v) => setCm(v as CodeModel)} />
        <Param spec={seg("Link into", [["exe", "exe"], ["pie", "PIE"], ["shared", ".so"]], "shared")} value={out} onChange={(v) => setOut(v as Output)} />
        <Param spec={seg("counter and add are in", [["same", "this link"], ["so", "libdef.so"]], "same")} value={defs} onChange={(v) => setDefs(v as DefsIn)} />
        {out === "shared" && <Param spec={toggle({ label: "-Bsymbolic", default: false })} value={bsym} onChange={(v) => setBsym(v as boolean)} />}
      </>}
    >
      <pre style={{ ...mono, fontSize: 11.5, margin: "0 0 6px", padding: "5px 8px", background: "var(--subtle)", borderRadius: 6, overflowX: "auto" }}>{PIC_SOURCE}</pre>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, minWidth: 520 }}>
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              <th style={{ padding: "3px 6px", fontWeight: 600 }}>symbol</th>
              <th style={{ padding: "3px 6px", fontWeight: 600 }}>{CM_LABEL[cm]} writes</th>
              <th style={{ padding: "3px 6px", fontWeight: 600 }}>the linker</th>
              <th style={{ padding: "3px 6px", fontWeight: 600 }}>{OUT_LABEL[out]} gets</th>
            </tr>
          </thead>
          <tbody>
            {r.refs.map((x) => (
              <tr key={x.symbol} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "4px 6px", ...mono }}>{x.symbol}<div className="muted" style={{ fontSize: 10.5 }}>{x.preemptible ? "preemptible" : "local to this file"}</div></td>
                <td style={{ padding: "4px 6px", ...mono, fontSize: 11 }}>{x.objCode}<div className="muted">{x.objReloc.replace("R_X86_64_", "")}</div></td>
                <td style={{ padding: "4px 6px" }}><Chip color={ACTION_COLOR[x.action]}>{x.action}</Chip></td>
                <td style={{ padding: "4px 6px", ...mono, fontSize: 11 }}>{x.error ? <span style={{ color: "var(--c4)" }}>error</span> : x.code}{x.dynReloc && <div style={{ color: "var(--c2)" }}>+ {x.dynReloc.replace("R_X86_64_", "")}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.errors.length ? (
        <Banner tone="bad" label="ld.lld"><span style={{ ...mono, fontSize: 12 }}>error: {r.errors[0]}</span>{r.errors.length > 1 && <span className="muted"> ({r.errors.length} errors in all)</span>}</Banner>
      ) : (
        <Banner tone={r.dynRelocs.length ? "warn" : "good"} label={`${r.dynRelocs.length} dynamic relocation${r.dynRelocs.length === 1 ? "" : "s"}`}>
          {r.dynRelocs.length ? <>ld.so must patch: <span style={mono}>{r.dynRelocs.map((d) => d.replace("R_X86_64_", "")).join(", ")}</span>.</> : "The static linker resolved everything. ld.so has nothing to look up for these three names."}
        </Banner>
      )}
      <SectionLabel>All nine pairs for "{defs === "same" ? "this link" : "libdef.so"}" (dynamic relocations, or ✕ for an error)</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, ...mono }}>
          <thead><tr><th />{outs.map((o) => <th key={o} style={{ padding: "2px 8px", fontWeight: 500, color: "var(--muted)" }}>{o === "shared" ? ".so" : o === "pie" ? "PIE" : "exe"}</th>)}</tr></thead>
          <tbody>
            {cms.map((c) => (
              <tr key={c}>
                <th style={{ padding: "2px 8px", fontWeight: 500, color: "var(--muted)", textAlign: "right" }}>{CM_LABEL[c]}</th>
                {outs.map((o) => {
                  const x = picOutcome(c, o, defs, bsym && o === "shared");
                  const on = c === cm && o === out;
                  const col = x.errors.length ? "var(--c4)" : x.dynRelocs.length ? "var(--c2)" : "var(--c3)";
                  return <td key={o} onClick={() => { setCm(c); setOut(o); }} style={{ width: 56, height: 26, textAlign: "center", cursor: "pointer", background: tint(col, on ? 55 : 18), border: on ? "2px solid var(--fg)" : "1px solid var(--bg)" }}>{x.errors.length ? "✕" : x.dynRelocs.length}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>Each cell matches a real link with clang 22 and ld.lld 22. GCC's -fPIE code reads counter directly (PC32), like -fno-pic here. Click a cell to see it.</Note>
    </Demo>
  );
}
