/**
 * Static archives (.a files) and the order of the linker command line.
 *
 * An archive is a bag of object files with an index of the symbols that each one defines. The linker extracts a
 * member only if it defines a symbol that is undefined at that moment. Two rule sets exist:
 *
 * - GNU ld and gold: the linker searches an archive once, at its place on the command line. Inside that search
 *   it repeats until no new member is needed. A later file cannot pull a member from an earlier archive, unless
 *   --start-group ... --end-group repeats the search of the group (GNU ld manual, "Options", --start-group).
 * - ld.lld: the linker remembers every archive symbol it has seen ("lazy" symbols). A later reference still
 *   extracts the member. --warn-backrefs prints a warning for each reference that GNU ld would not resolve
 *   (lld docs, "--warn-backrefs"). A warning is dropped if the same archive appears again after the referencing file.
 *
 * The golden data for the test came from ld.lld 22.1.8 with --warn-backrefs.
 */

export interface Member { name: string; defines: string[]; needs: string[] }
export interface CmdItem { kind: "obj" | "lib"; name: string; members: Member[] }

/** The example: main.o needs compress; libz and liblog depend on each other. */
export const LIBZ: CmdItem = {
  kind: "lib", name: "libz.a", members: [
    { name: "deflate.o", defines: ["compress"], needs: ["log_msg"] },
    { name: "crc.o", defines: ["crc32"], needs: [] },
    { name: "gzip.o", defines: ["gzip_file"], needs: [] },
  ],
};
export const LIBLOG: CmdItem = {
  kind: "lib", name: "liblog.a", members: [
    { name: "log.o", defines: ["log_msg"], needs: ["crc32"] },
    { name: "level.o", defines: ["log_level"], needs: [] },
  ],
};
export const MAIN_OBJ: CmdItem = { kind: "obj", name: "main.o", members: [{ name: "main.o", defines: ["main"], needs: ["compress"] }] };

export interface ScanEvent {
  /** Index of the command-line item. */
  item: number;
  text: string;
  kind: "read" | "extract" | "skip" | "warn" | "group";
  /** The archive member, for an extract event. */
  member?: string;
  /** Undefined symbols after this event. */
  undefined: string[];
}

export interface ScanResult {
  events: ScanEvent[];
  extracted: string[];
  undefined: string[];
  warnings: string[];
  ok: boolean;
}

/**
 * Runs the scan. `group` is an inclusive [first, last] range of item indices wrapped in --start-group/--end-group.
 */
export function scanArchives(items: CmdItem[], mode: "gnu" | "lld", group: [number, number] | null = null): ScanResult {
  return mode === "gnu" ? scanGnu(items, group) : scanLld(items, group);
}

function scanGnu(items: CmdItem[], group: [number, number] | null): ScanResult {
  const defined = new Set<string>();
  const undef = new Set<string>();
  const extracted = new Set<string>();
  const events: ScanEvent[] = [];
  const snap = () => [...undef].sort();
  const addMember = (m: Member) => {
    for (const d of m.defines) { defined.add(d); undef.delete(d); }
    for (const n of m.needs) if (!defined.has(n)) undef.add(n);
  };
  /** One search of an archive: repeat until no member is extracted. Returns the number extracted. */
  const searchLib = (i: number) => {
    const lib = items[i]!;
    let total = 0;
    for (let again = true; again;) {
      again = false;
      for (const m of lib.members) {
        const key = `${lib.name}(${m.name})`;
        if (extracted.has(key)) continue;
        const hit = m.defines.find((d) => undef.has(d));
        if (!hit) continue;
        extracted.add(key);
        addMember(m);
        events.push({ item: i, kind: "extract", member: m.name, text: `extract ${m.name}: it defines ${hit}${m.needs.length ? `, and it needs ${m.needs.join(", ")}` : ""}`, undefined: snap() });
        again = true;
        total++;
      }
    }
    if (total === 0) events.push({ item: i, kind: "skip", text: undef.size ? `nothing here defines ${snap().join(", ")}` : "nothing is undefined, so nothing is extracted", undefined: snap() });
    return total;
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (group && i === group[0]) {
      let pass = 0;
      for (let more = true; more;) {
        pass++;
        if (pass > 1) events.push({ item: i, kind: "group", text: `--end-group: pass ${pass} over the group, because the last pass extracted members`, undefined: snap() });
        more = false;
        for (let j = group[0]; j <= group[1]; j++) {
          if (items[j]!.kind === "obj") { if (pass === 1) readObj(j); continue; }
          if (searchLib(j) > 0) more = true;
        }
      }
      i = group[1];
      continue;
    }
    if (it.kind === "obj") readObj(i);
    else searchLib(i);
  }
  function readObj(i: number) {
    const it = items[i]!;
    for (const m of it.members) addMember(m);
    events.push({ item: i, kind: "read", text: `read ${it.name}: it needs ${it.members.flatMap((m) => m.needs).join(", ") || "nothing"}`, undefined: snap() });
  }
  return { events, extracted: [...extracted], undefined: snap(), warnings: [], ok: undef.size === 0 };
}

function scanLld(items: CmdItem[], group: [number, number] | null): ScanResult {
  const defined = new Set<string>();
  const undef = new Map<string, number>(); // symbol → position of the first file that needs it
  const lazy = new Map<string, { lib: number; member: Member }>();
  const extracted = new Set<string>();
  const events: ScanEvent[] = [];
  const pending: { text: string; refPos: number; lib: number }[] = [];
  const inGroup = (i: number) => !!group && i >= group[0] && i <= group[1];
  const snap = () => [...undef.keys()].sort();
  const label = (pos: number, m: Member) => (items[pos]!.kind === "lib" ? `${items[pos]!.name}(${m.name})` : items[pos]!.name);

  const need = (sym: string, pos: number, from: string) => {
    if (defined.has(sym) || undef.has(sym)) return;
    const l = lazy.get(sym);
    if (l) {
      if (l.lib < pos && !(inGroup(l.lib) && inGroup(pos))) pending.push({ text: `backward reference detected: ${sym} in ${from} refers to ${items[l.lib]!.name}(${l.member.name})`, refPos: pos, lib: l.lib });
      extract(l.lib, l.member, sym);
    } else undef.set(sym, pos);
  };
  const extract = (lib: number, m: Member, why: string) => {
    const key = `${items[lib]!.name}(${m.name})`;
    if (extracted.has(key)) return;
    extracted.add(key);
    for (const d of m.defines) { defined.add(d); undef.delete(d); lazy.delete(d); }
    events.push({ item: lib, kind: "extract", member: m.name, text: `extract ${m.name}: it defines ${why}${m.needs.length ? `, and it needs ${m.needs.join(", ")}` : ""}`, undefined: snap() });
    for (const n of m.needs) need(n, lib, label(lib, m));
  };
  items.forEach((it, i) => {
    if (it.kind === "obj") {
      for (const m of it.members) for (const d of m.defines) { defined.add(d); undef.delete(d); lazy.delete(d); }
      events.push({ item: i, kind: "read", text: `read ${it.name}: it needs ${it.members.flatMap((m) => m.needs).join(", ") || "nothing"}`, undefined: snap() });
      for (const m of it.members) for (const n of m.needs) need(n, i, it.name);
      return;
    }
    let n = 0;
    for (const m of it.members) {
      const hit = m.defines.find((d) => undef.has(d));
      if (hit) { extract(i, m, hit); n++; continue; }
      if (extracted.has(`${it.name}(${m.name})`)) continue;
      for (const d of m.defines) if (!defined.has(d) && !lazy.has(d)) lazy.set(d, { lib: i, member: m });
    }
    if (n === 0) events.push({ item: i, kind: "skip", text: `remember the symbols of ${it.name} for later: ${it.members.flatMap((m) => m.defines).filter((d) => lazy.has(d)).join(", ") || "none left"}`, undefined: snap() });
  });
  // A warning is dropped if the same archive appears again after the referencing file.
  const warnings = pending.filter((p) => !items.some((it, j) => j > p.refPos && it.name === items[p.lib]!.name)).map((p) => p.text);
  for (const w of warnings) events.push({ item: items.length - 1, kind: "warn", text: `warning: ${w}`, undefined: snap() });
  return { events, extracted: [...extracted], undefined: snap(), warnings, ok: undef.size === 0 };
}
