/** Demos for "files, inodes and directories": a file tree over inodes, and the three tables of open files. */
import { useMemo, useRef, useState } from "react";
import { Demo, Param, Stats, select, useParams } from "../../kit";
import { MemFs, OpenTables, TABLE_SCENARIOS, applyTableOp, type FsError } from "../../sims/os/fs/inodefs";
import { Banner, Heading, MONO, Note, fileColor, smallBtn } from "./FsUi";

// ---------------------------------------------------------------- the inode tree

const GRID_COLS = 16;

function initialFs() {
  const fs = new MemFs({ blocks: 48, inodes: 16 });
  fs.create("/notes.txt");
  fs.write("/notes.txt", 0, 6000);
  fs.mkdir("/docs");
  fs.create("/docs/plan.txt");
  fs.write("/docs/plan.txt", 0, 100);
  return fs;
}

const say: Record<FsError, string> = {
  ENOENT: "ENOENT: no such name.",
  EEXIST: "EEXIST: that name is in use.",
  ENOTDIR: "ENOTDIR: a directory cannot replace a file.",
  EISDIR: "EISDIR: this needs a file, and a directory is selected.",
  ENOTEMPTY: "ENOTEMPTY: the directory holds entries.",
  EPERM: "EPERM: a hard link to a directory is not allowed, because it could make a cycle.",
  ENOSPC: "ENOSPC: no free block or no free inode.",
  EINVAL: "EINVAL: a directory cannot move inside itself.",
  ELOOP: "ELOOP: too many symlinks.",
  EBADF: "EBADF: this inode is not open.",
};

export function FsInodeTreeDemo() {
  const [fs, setFs] = useState(initialFs);
  const [sel, setSel] = useState("/notes.txt");
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>({ text: "Select a name, and then use a button. Each name is only a pointer to an inode." });
  const [, force] = useState(0);
  const counter = useRef(1);
  const list = fs.list();
  const selRow = list.find((r) => r.path === sel);
  const selIno = selRow ? fs.inodes.get(selRow.ino)! : null;
  const parentDir = selRow?.kind === "dir" ? sel : sel.slice(0, sel.lastIndexOf("/"));

  const act = (r: FsError | null, ok: string) => {
    setMsg(r ? { text: say[r], bad: true } : { text: ok });
    force((x) => x + 1);
  };
  const fresh = (base: string) => {
    const n = counter.current++;
    return `${parentDir}/${base}${n}`;
  };
  const freed = (before: number) => {
    const d = fs.freeBlocks - before;
    return d > 0 ? `${d} block${d === 1 ? "" : "s"} went back to the free pool.` : "No block went back to the free pool.";
  };

  const onRow = (path: string) => {
    if (picking) {
      setPicking(false);
      const target = list.find((r) => r.path === path)!;
      const to = target.kind === "dir" && selRow?.kind !== "dir" ? `${path}/${selRow!.name}` : path;
      const before = fs.freeBlocks;
      const had = fs.resolve(to, false);
      const r = fs.rename(sel, to);
      if (!r) setSel(to);
      act(r, typeof had === "number" && had !== selRow!.ino ? `rename replaced ${to} in one step. The old inode lost one link. ${freed(before)}` : `rename changed only directory entries. Inode ${selRow!.ino} did not move, and no data block was touched.`);
      return;
    }
    setSel(path);
  };

  const inodes = [...fs.inodes.values()];
  const free = fs.freeBlocks;

  return (
    <Demo
      title="A file tree over an inode table"
      actions={<button className="btn ghost" onClick={() => { setFs(initialFs()); setSel("/notes.txt"); setPicking(false); setMsg({ text: "Reset." }); }}>Reset</button>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12 }}>
        <div>
          <Heading>Names (directory entries)</Heading>
          <div style={{ fontFamily: MONO, fontSize: 12.5, border: "1px solid var(--border)", borderRadius: 6, padding: 4, minHeight: 110 }}>
            {list.map((r) => {
              const on = r.path === sel;
              return (
                <button key={r.path} onClick={() => onRow(r.path)} style={{ display: "flex", justifyContent: "space-between", gap: 6, width: "100%", textAlign: "left", font: "inherit", cursor: "pointer", padding: `2px 4px 2px ${4 + r.depth * 14}px`, border: 0, borderRadius: 4, background: on ? "var(--subtle)" : "transparent", color: "var(--fg)", outline: on ? "1.5px solid var(--fg)" : "none", outlineOffset: -1 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}{r.kind === "dir" ? "/" : ""}{r.kind === "symlink" ? ` -> ${fs.inodes.get(r.ino)!.target}` : ""}</span>
                  <span style={{ color: fileColor(r.ino), fontWeight: 600 }}>{r.ino}</span>
                </button>
              );
            })}
            {list.length === 0 && <div className="muted" style={{ padding: 4 }}>The root directory is empty.</div>}
          </div>
        </div>
        <div>
          <Heading>Inode table</Heading>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: MONO, fontSize: 12 }}>
              <thead>
                <tr className="muted" style={{ textAlign: "right" }}>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>ino</th><th style={{ textAlign: "left", fontWeight: 500 }}>type</th><th style={{ fontWeight: 500 }}>links</th><th style={{ fontWeight: 500 }}>open</th><th style={{ fontWeight: 500 }}>size</th><th style={{ fontWeight: 500 }}>blocks</th>
                </tr>
              </thead>
              <tbody>
                {inodes.map((n) => (
                  <tr key={n.ino} style={{ borderTop: "1px solid var(--border)", textAlign: "right", background: selIno?.ino === n.ino ? "var(--subtle)" : undefined, color: n.nlink === 0 ? "var(--c4)" : undefined }}>
                    <td style={{ textAlign: "left", color: fileColor(n.ino), fontWeight: 600 }}>{n.ino}</td>
                    <td style={{ textAlign: "left" }}>{n.kind === "symlink" ? "link" : n.kind}</td>
                    <td>{n.nlink}</td><td>{n.openCount}</td><td>{n.size}</td><td>{n.map.size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <Heading>Data blocks, colored by owner inode</Heading>
        <svg viewBox={`0 0 ${GRID_COLS * 20} ${Math.ceil(fs.totalBlocks / GRID_COLS) * 20}`} style={{ width: "100%", maxWidth: 480, display: "block" }} role="img" aria-label="block bitmap">
          {Array.from(fs.owner).map((o, i) => (
            <g key={i} transform={`translate(${(i % GRID_COLS) * 20},${Math.floor(i / GRID_COLS) * 20})`}>
              <rect x={1} y={1} width={18} height={18} rx={2} fill={o ? fileColor(o) : "var(--subtle)"} stroke="var(--border)" strokeWidth={0.5} opacity={o ? 0.85 : 1} />
              {o !== 0 && <text x={10} y={13.5} textAnchor="middle" fontSize={9.5} fill="var(--bg)" fontFamily={MONO}>{o}</text>}
            </g>
          ))}
        </svg>
      </div>

      <div className="row" style={{ flexWrap: "wrap", gap: 5, marginTop: 10 }}>
        <button className="btn" style={smallBtn} onClick={() => { const p = fresh("file"); const r = fs.create(p); if (!r) setSel(p); act(r, `create took a free inode and added one entry in ${parentDir || "/"}. The file has no data blocks yet.`); }}>New file</button>
        <button className="btn" style={smallBtn} onClick={() => { const p = fresh("dir"); const r = fs.mkdir(p); if (!r) setSel(p); act(r, "mkdir took an inode and one block. The new directory has 2 links: its name and its own \".\". The parent gained 1 link from \"..\"."); }}>New directory</button>
        <button className="btn" style={smallBtn} disabled={!selIno || selIno.kind !== "file"} onClick={() => act(fs.write(sel, selIno!.size, 4096), "write allocated what it needed from the bitmap and grew the size.")}>Append 4 KiB</button>
        <button className="btn" style={smallBtn} disabled={!selIno || selIno.kind !== "file"} onClick={() => act(fs.write(sel, selIno!.size + 40 * 4096, 1), "This write landed 40 blocks past the end. The size jumped, but only one block was allocated. The gap is a hole.")}>Write past the end</button>
        <button className="btn" style={smallBtn} disabled={!selIno || selIno.kind === "dir"} onClick={() => { const p = fresh(`${selRow!.name}.ln`); act(fs.link(sel, p), "link added a second name for the same inode. The link count grew. No data moved."); }}>Hard link</button>
        <button className="btn" style={smallBtn} disabled={!selRow} onClick={() => { const p = fresh(`${selRow!.name}.sym`); act(fs.symlink(sel, p), "symlink made a new inode that stores a path. The target's link count did not change. A short target fits in the inode, so it takes no block."); }}>Symlink</button>
        <button className="btn" style={{ ...smallBtn, outline: picking ? "2px solid var(--c2)" : "none" }} disabled={!selRow} onClick={() => { setPicking(!picking); setMsg({ text: picking ? "Rename cancelled." : "Now click a target name. A file target gets replaced. A directory target receives the file." }); }}>{picking ? "Pick a target" : "Rename onto"}</button>
        <button className="btn" style={smallBtn} disabled={!selIno || selIno.kind !== "file"} onClick={() => { const r = fs.open(sel); act(typeof r === "string" ? r : null, "open took a reference on the inode in memory."); }}>Open</button>
        <button className="btn" style={smallBtn} disabled={!inodes.some((n) => n.openCount > 0)} onClick={() => {
          const n = (selIno && selIno.openCount > 0 ? selIno : inodes.find((x) => x.openCount > 0))!;
          const before = fs.freeBlocks;
          const dead = n.nlink === 0 && n.openCount === 1;
          act(fs.close(n.ino), dead ? `This was the last reference to an inode with no names. Inode ${n.ino} is gone. ${freed(before)}` : "close dropped one reference. The inode stays.");
        }}>Close</button>
        <button className="btn" style={smallBtn} disabled={!selRow} onClick={() => {
          const before = fs.freeBlocks;
          const n = selIno!;
          const isDir = n.kind === "dir";
          const r = isDir ? fs.rmdir(sel) : fs.unlink(sel);
          if (!r) { setSel(fs.list()[0]?.path ?? ""); }
          act(r, isDir ? `rmdir removed the directory. ${freed(before)}` : n.nlink > 0 ? `unlink removed one name. Inode ${n.ino} still has ${n.nlink} link${n.nlink === 1 ? "" : "s"}, so it stays. ${freed(before)}` : n.openCount > 0 ? `The last name is gone, but a process holds inode ${n.ino} open. ${freed(before)} A reader can still use the file.` : `The last name is gone, and nothing holds the file open. ${freed(before)}`);
        }}>{selIno?.kind === "dir" ? "rmdir" : "unlink"}</button>
      </div>

      <Banner tone={msg.bad ? "bad" : "plain"}>{msg.text}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "free blocks", value: `${free} / ${fs.totalBlocks}` },
          { label: "free inodes", value: `${fs.freeInodes} / ${fs.totalInodes}` },
          { label: "selected: st_size", value: selIno ? selIno.size : "none" },
          { label: "selected: st_blocks", value: selIno ? (selIno.map.size * 4096) / 512 : "none" },
          { label: "orphans (no name, still open)", value: fs.orphans.size },
        ]} />
      </div>
      <Note>st_blocks counts 512-byte units, so one 4 KiB block shows as 8. Directories start with one block.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- three tables

const TT = { scenario: select({ label: "Scenario", segmented: true, options: TABLE_SCENARIOS.map((s) => ({ value: s.id, label: s.label })), default: "two-opens" }) };

const COL1 = 8, COL2 = 148, COL3 = 288, W = 400;

export function FsThreeTablesDemo() {
  const P = useParams("os-fs-tables", TT);
  const sc = TABLE_SCENARIOS.find((s) => s.id === P.values.scenario)!;
  const [n, setN] = useState(0);
  const view = useMemo(() => {
    const t = new OpenTables(sc.files);
    const log: { text: string; say: string; at?: number; len?: number; pid?: number }[] = [];
    for (let i = 0; i < Math.min(n, sc.ops.length); i++) {
      const o = sc.ops[i]!;
      const r = applyTableOp(t, o);
      log.push({ ...r, len: "n" in o ? o.n : undefined, pid: "pid" in o ? o.pid : undefined });
    }
    return { t, log };
  }, [sc, n]);
  const { t, log } = view;
  const procs = [...t.procs.values()];
  const files = [...t.files.values()];
  const inodes = [...t.inodes.values()];

  // Layout in viewBox units.
  const rowH = 22;
  const fdY = new Map<string, number>();
  let y = 24;
  const procBoxes = procs.map((p) => {
    const top = y;
    const rows = [...p.fds.keys()].sort((a, b) => a - b);
    rows.forEach((fd, i) => fdY.set(`${p.pid}/${fd}`, top + 20 + i * rowH + rowH / 2));
    const h = 20 + Math.max(1, rows.length) * rowH + 4;
    y += h + 8;
    return { p, top, rows, h };
  });
  const H1 = y;
  const fileY = new Map<number, number>();
  let y2 = 24;
  const fileBoxes = files.map((f) => {
    const top = y2;
    fileY.set(f.id, top + 25);
    y2 += 58;
    return { f, top };
  });
  const inoY = new Map<number, number>();
  let y3 = 24;
  const inoBoxes = inodes.map((i) => {
    const top = y3;
    inoY.set(i.ino, top + 25);
    y3 += 66;
    return { i, top };
  });
  const H = Math.max(H1, y2, y3, 110) + 4;
  const sizeMax = Math.max(300, ...inodes.map((i) => i.size));

  const writes = log.filter((l) => l.at !== undefined);

  return (
    <Demo
      title="Three tables: fd, open file description, inode"
      actions={
        <>
          <button className="btn" onClick={() => setN(Math.max(0, n - 1))} disabled={n === 0}>Back</button>
          <button className="btn primary" onClick={() => setN(Math.min(sc.ops.length, n + 1))} disabled={n >= sc.ops.length}>Next</button>
          <button className="btn ghost" onClick={() => setN(0)}>Reset</button>
        </>
      }
      controls={<Param spec={TT.scenario} value={P.values.scenario} onChange={(v) => { P.set("scenario", v as never); setN(0); }} />}
    >
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 640, display: "block" }} role="img" aria-label="fd tables, open file table and inode table">
        <text x={COL1} y={12} fontSize={11} fill="var(--muted)">per-process fd table</text>
        <text x={COL2} y={12} fontSize={11} fill="var(--muted)">open file table</text>
        <text x={COL3} y={12} fontSize={11} fill="var(--muted)">inode table</text>
        {procBoxes.flatMap(({ p, rows }) => rows.map((fd) => {
          const id = p.fds.get(fd)!;
          const f = t.files.get(id)!;
          const y1 = fdY.get(`${p.pid}/${fd}`)!, y2b = fileY.get(id)!;
          return <path key={`${p.pid}-${fd}`} d={`M ${COL1 + 100} ${y1} C ${COL1 + 120} ${y1}, ${COL2 - 20} ${y2b}, ${COL2} ${y2b}`} fill="none" stroke={fileColor(f.id)} strokeWidth={1.4} />;
        }))}
        {fileBoxes.map(({ f }) => <path key={f.id} d={`M ${COL2 + 104} ${fileY.get(f.id)!} C ${COL2 + 120} ${fileY.get(f.id)!}, ${COL3 - 18} ${inoY.get(f.ino)!}, ${COL3} ${inoY.get(f.ino)!}`} fill="none" stroke={fileColor(f.id)} strokeWidth={1.4} />)}
        {procBoxes.map(({ p, top, rows, h }) => (
          <g key={p.pid}>
            <rect x={COL1} y={top} width={100} height={h} rx={4} fill="var(--bg)" stroke="var(--border)" />
            <text x={COL1 + 6} y={top + 14} fontSize={11} fontWeight={600} fill="var(--fg)">pid {p.pid}</text>
            {rows.length === 0 && <text x={COL1 + 6} y={top + 34} fontSize={10.5} fill="var(--muted)">no files open</text>}
            {rows.map((fd, i) => <text key={fd} x={COL1 + 6} y={top + 20 + i * rowH + 15} fontSize={11.5} fontFamily={MONO} fill="var(--fg)">fd {fd}</text>)}
          </g>
        ))}
        {fileBoxes.map(({ f, top }) => (
          <g key={f.id}>
            <rect x={COL2} y={top} width={104} height={50} rx={4} fill="var(--bg)" stroke={fileColor(f.id)} strokeWidth={1.4} />
            <text x={COL2 + 6} y={top + 14} fontSize={11} fontWeight={600} fill={fileColor(f.id)}>struct file {f.id}</text>
            <text x={COL2 + 6} y={top + 29} fontSize={11.5} fontFamily={MONO} fill="var(--fg)">offset {f.offset}</text>
            <text x={COL2 + 6} y={top + 43} fontSize={10.5} fill="var(--muted)">refs {f.refs}{f.append ? ", O_APPEND" : ""}</text>
          </g>
        ))}
        {inoBoxes.map(({ i, top }) => (
          <g key={i.ino}>
            <rect x={COL3} y={top} width={104} height={58} rx={4} fill="var(--bg)" stroke="var(--border)" />
            <text x={COL3 + 6} y={top + 14} fontSize={11} fontWeight={600} fill="var(--fg)">inode {i.ino}</text>
            <text x={COL3 + 6} y={top + 29} fontSize={10.5} fill="var(--muted)">{i.name}</text>
            <text x={COL3 + 6} y={top + 43} fontSize={11.5} fontFamily={MONO} fill="var(--fg)">size {i.size}</text>
            <text x={COL3 + 6} y={top + 54} fontSize={9.5} fill="var(--muted)">refs {i.refs}</text>
          </g>
        ))}
      </svg>

      <div style={{ marginTop: 8 }}>
        <Heading>Where the writes landed in the file</Heading>
        <svg viewBox="0 0 400 34" style={{ width: "100%", maxWidth: 640, display: "block" }} role="img" aria-label="write positions">
          <rect x={0} y={4} width={400} height={18} fill="var(--subtle)" />
          {writes.map((w, i) => (
            <g key={i}>
              <rect x={(w.at! / sizeMax) * 400} y={i === writes.length - 1 ? 4 : 4} width={((w.len ?? 0) / sizeMax) * 400} height={18} fill={fileColor(i)} opacity={0.55} stroke="var(--fg)" strokeWidth={0.5} />
              <text x={(w.at! / sizeMax) * 400 + 3} y={17 - 0} fontSize={10.5} fill="var(--fg)">{`w${i + 1}`}</text>
            </g>
          ))}
          <text x={0} y={33} fontSize={9.5} fill="var(--muted)">0</text>
          <text x={400} y={33} fontSize={9.5} fill="var(--muted)" textAnchor="end">{sizeMax} bytes</text>
        </svg>
      </div>

      <Banner>{log.length ? <><code>{log[log.length - 1]!.text}</code> {log[log.length - 1]!.say}</> : "Press Next to run the first system call."}</Banner>
      {n >= sc.ops.length && <Note>{SCENARIO_END[sc.id]}</Note>}
    </Demo>
  );
}

const SCENARIO_END: Record<string, string> = {
  "two-opens": "Two writes landed at offset 0, so the second overwrote the first. Each open has its own offset.",
  dup: "The second write followed the first, because dup shares one offset.",
  fork: "Parent and child append in turn with no coordination. The description lives until the last reference goes.",
  "fork-open": "A fork before the open gives two independent descriptions, so the writes overwrite each other.",
  append: "O_APPEND moves the offset to the end inside each write, so separate opens do not overwrite each other.",
};
