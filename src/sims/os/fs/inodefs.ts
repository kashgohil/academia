/**
 * An in-memory file system with the same objects as a Unix disk file system: an inode table, directories that map
 * names to inode numbers, and a block bitmap. Space goes back to the free pool only when the link count is zero and
 * no process holds the file open, which is the rule that makes "unlink an open file" work.
 *
 * It also holds the on-disk layout arithmetic of ext4 (`ext4Layout`) and the three tables of open files (`OpenTables`).
 */

export type FsError = "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EPERM" | "ENOSPC" | "EINVAL" | "ELOOP" | "EBADF";
export type InodeKind = "file" | "dir" | "symlink";

export interface Inode {
  ino: number;
  kind: InodeKind;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  /** Bytes, as stat reports them in st_size. A sparse file has a size larger than its blocks. */
  size: number;
  /** Logical block number to physical block number. A missing key is a hole. */
  map: Map<number, number>;
  /** Directories only: name to inode number. */
  entries: Map<string, number> | null;
  /** Directories only: the parent directory, which is what ".." means. */
  parent: number;
  /** Symlinks only. */
  target: string | null;
  /** Open references held in memory. */
  openCount: number;
  mtime: number;
  ctime: number;
}

export interface Stat {
  ino: number; kind: InodeKind; mode: number; uid: number; gid: number; nlink: number; size: number;
  /** st_blocks: allocated space in units of 512 bytes, whatever the block size is. */
  blocks512: number;
  blksize: number; mtime: number; ctime: number;
}

export interface MemFsOpts { blocks: number; inodes: number; blockSize?: number }

/** ext4 stores a symlink target shorter than this in the inode's 60-byte i_block area. */
export const FAST_SYMLINK_LIMIT = 60;
/** The kernel gives up after this many symlinks in one path lookup (MAXSYMLINKS). */
export const MAX_SYMLINKS = 40;
export const ROOT_INO = 2;

const direntBytes = (name: string) => 8 + ((name.length + 3) & ~3);

export class MemFs {
  readonly blockSize: number;
  readonly totalBlocks: number;
  readonly totalInodes: number;
  /** Owner inode of each block, 0 if free. */
  readonly owner: Int32Array;
  readonly inodes = new Map<number, Inode>();
  private nextIno = ROOT_INO;
  private cursor = 0;
  private clock = 0;
  private usedBlocks = 0;
  /** Inode numbers with nlink 0 that are still open: the ext4 orphan list. */
  readonly orphans = new Set<number>();

  constructor(o: MemFsOpts) {
    this.blockSize = o.blockSize ?? 4096;
    this.totalBlocks = o.blocks;
    this.totalInodes = o.inodes;
    this.owner = new Int32Array(o.blocks);
    const root = this.newInode("dir", 0o755)!;
    root.nlink = 2;
    root.parent = root.ino;
    root.entries = new Map();
    this.growDir(root);
  }

  get freeBlocks() { return this.totalBlocks - this.usedBlocks; }
  get freeInodes() { return this.totalInodes - this.inodes.size; }

  private tick() { return ++this.clock; }

  private newInode(kind: InodeKind, mode: number): Inode | null {
    if (this.inodes.size >= this.totalInodes) return null;
    const ino = this.nextIno++;
    const t = this.tick();
    const n: Inode = { ino, kind, mode, uid: 0, gid: 0, nlink: 1, size: 0, map: new Map(), entries: kind === "dir" ? new Map() : null, parent: 0, target: null, openCount: 0, mtime: t, ctime: t };
    this.inodes.set(ino, n);
    return n;
  }

  private allocBlock(ino: number): number {
    for (let i = 0; i < this.totalBlocks; i++) {
      const b = (this.cursor + i) % this.totalBlocks;
      if (this.owner[b] === 0) {
        this.owner[b] = ino;
        this.usedBlocks++;
        this.cursor = (b + 1) % this.totalBlocks;
        return b;
      }
    }
    throw new Error("allocBlock with no free block: the caller must check first");
  }

  private freeBlock(b: number) {
    if (this.owner[b] === 0) throw new Error(`double free of block ${b}`);
    this.owner[b] = 0;
    this.usedBlocks--;
  }

  /** A directory's bytes are its entries, and it holds at least one block. Directories do not shrink. */
  private dirBlocksNeeded(d: Inode, extra = 0) {
    let bytes = extra + 24; // "." and ".."
    for (const name of d.entries!.keys()) bytes += direntBytes(name);
    return Math.max(1, Math.ceil(bytes / this.blockSize));
  }

  private growDir(d: Inode) {
    while (d.map.size < this.dirBlocksNeeded(d)) d.map.set(d.map.size, this.allocBlock(d.ino));
    d.size = d.map.size * this.blockSize;
  }

  private dropIfDead(n: Inode) {
    if (n.nlink > 0) return;
    if (n.openCount > 0) { this.orphans.add(n.ino); return; }
    this.orphans.delete(n.ino);
    for (const b of n.map.values()) this.freeBlock(b);
    this.inodes.delete(n.ino);
  }

  /** Follows a path from the root. `follow` says whether a symlink in the last component is followed. */
  resolve(path: string, follow = true, budget = { links: MAX_SYMLINKS }): number | FsError {
    if (!path.startsWith("/")) return "EINVAL";
    return this.walk(ROOT_INO, path, follow, budget);
  }

  private walk(start: number, path: string, follow: boolean, budget: { links: number }): number | FsError {
    let cur = path.startsWith("/") ? ROOT_INO : start;
    const parts = path.split("/").filter((p) => p && p !== ".");
    for (let i = 0; i < parts.length; i++) {
      const d = this.inodes.get(cur)!;
      if (d.kind !== "dir") return "ENOTDIR";
      const name = parts[i]!;
      if (name === "..") { cur = d.parent; continue; }
      const c = d.entries!.get(name);
      if (c === undefined) return "ENOENT";
      const n = this.inodes.get(c)!;
      if (n.kind === "symlink" && (follow || i < parts.length - 1)) {
        if (budget.links-- <= 0) return "ELOOP";
        const r = this.walk(cur, n.target!, true, budget);
        if (typeof r === "string") return r;
        cur = r;
      } else cur = c;
    }
    return cur;
  }

  /** Finds the parent directory and the last name. */
  private parentOf(path: string): { dir: Inode; name: string } | FsError {
    if (!path.startsWith("/")) return "EINVAL";
    const trimmed = path.replace(/\/+$/, "");
    const at = trimmed.lastIndexOf("/");
    const name = trimmed.slice(at + 1);
    if (!name || name === "." || name === "..") return "EINVAL";
    const p = this.resolve(trimmed.slice(0, at) || "/");
    if (typeof p === "string") return p;
    const dir = this.inodes.get(p)!;
    if (dir.kind !== "dir") return "ENOTDIR";
    return { dir, name };
  }

  private addEntry(dir: Inode, name: string, ino: number) {
    dir.entries!.set(name, ino);
    this.growDir(dir);
    dir.mtime = dir.ctime = this.tick();
  }

  private dirRoom(dir: Inode, name: string): boolean {
    return this.dirBlocksNeeded(dir, direntBytes(name)) - dir.map.size <= this.freeBlocks;
  }

  create(path: string, mode = 0o644): FsError | null {
    const p = this.parentOf(path);
    if (typeof p === "string") return p;
    if (p.dir.entries!.has(p.name)) return "EEXIST";
    if (this.freeInodes < 1 || !this.dirRoom(p.dir, p.name)) return "ENOSPC";
    const n = this.newInode("file", mode)!;
    this.addEntry(p.dir, p.name, n.ino);
    return null;
  }

  mkdir(path: string, mode = 0o755): FsError | null {
    const p = this.parentOf(path);
    if (typeof p === "string") return p;
    if (p.dir.entries!.has(p.name)) return "EEXIST";
    if (this.freeInodes < 1 || !this.dirRoom(p.dir, p.name) || this.freeBlocks < 1 + (this.dirBlocksNeeded(p.dir, direntBytes(p.name)) - p.dir.map.size)) return "ENOSPC";
    const n = this.newInode("dir", mode)!;
    n.nlink = 2; // the entry in the parent, and its own "."
    n.parent = p.dir.ino;
    this.growDir(n);
    p.dir.nlink++; // the child's ".." points here
    this.addEntry(p.dir, p.name, n.ino);
    return null;
  }

  symlink(target: string, path: string): FsError | null {
    const p = this.parentOf(path);
    if (typeof p === "string") return p;
    if (p.dir.entries!.has(p.name)) return "EEXIST";
    const fast = target.length < FAST_SYMLINK_LIMIT;
    if (this.freeInodes < 1 || !this.dirRoom(p.dir, p.name) || (!fast && this.freeBlocks < 2)) return "ENOSPC";
    const n = this.newInode("symlink", 0o777)!;
    n.target = target;
    n.size = target.length;
    if (!fast) n.map.set(0, this.allocBlock(n.ino));
    this.addEntry(p.dir, p.name, n.ino);
    return null;
  }

  /** A hard link: a new name for the same inode. */
  link(existing: string, path: string): FsError | null {
    const src = this.resolve(existing, false);
    if (typeof src === "string") return src;
    const n = this.inodes.get(src)!;
    if (n.kind === "dir") return "EPERM"; // hard links to directories would allow cycles
    const p = this.parentOf(path);
    if (typeof p === "string") return p;
    if (p.dir.entries!.has(p.name)) return "EEXIST";
    if (!this.dirRoom(p.dir, p.name)) return "ENOSPC";
    n.nlink++;
    n.ctime = this.tick();
    this.addEntry(p.dir, p.name, n.ino);
    return null;
  }

  unlink(path: string): FsError | null {
    const p = this.parentOf(path);
    if (typeof p === "string") return p;
    const c = p.dir.entries!.get(p.name);
    if (c === undefined) return "ENOENT";
    const n = this.inodes.get(c)!;
    if (n.kind === "dir") return "EISDIR";
    p.dir.entries!.delete(p.name);
    p.dir.mtime = p.dir.ctime = this.tick();
    n.nlink--;
    n.ctime = this.tick();
    this.dropIfDead(n);
    return null;
  }

  rmdir(path: string): FsError | null {
    const p = this.parentOf(path);
    if (typeof p === "string") return p;
    const c = p.dir.entries!.get(p.name);
    if (c === undefined) return "ENOENT";
    const n = this.inodes.get(c)!;
    if (n.kind !== "dir") return "ENOTDIR";
    if (n.entries!.size > 0) return "ENOTEMPTY";
    p.dir.entries!.delete(p.name);
    p.dir.nlink--;
    p.dir.mtime = p.dir.ctime = this.tick();
    n.nlink = 0;
    this.dropIfDead(n);
    return null;
  }

  /**
   * rename(2). One directory update swaps the name to the new inode, so a reader of `to` finds the old file or the
   * new file, never nothing. If `to` existed, it loses one link. Both names on one inode make it a no-op, as POSIX says.
   */
  rename(from: string, to: string): FsError | null {
    const a = this.parentOf(from);
    if (typeof a === "string") return a;
    const srcIno = a.dir.entries!.get(a.name);
    if (srcIno === undefined) return "ENOENT";
    const b = this.parentOf(to);
    if (typeof b === "string") return b;
    const src = this.inodes.get(srcIno)!;
    if (src.kind === "dir") {
      for (let d = b.dir; ; d = this.inodes.get(d.parent)!) {
        if (d.ino === src.ino) return "EINVAL"; // a directory cannot move into itself
        if (d.ino === ROOT_INO) break;
      }
    }
    const dstIno = b.dir.entries!.get(b.name);
    if (dstIno === srcIno) return null;
    if (dstIno !== undefined) {
      const dst = this.inodes.get(dstIno)!;
      if (dst.kind === "dir" && src.kind !== "dir") return "EISDIR";
      if (dst.kind !== "dir" && src.kind === "dir") return "ENOTDIR";
      if (dst.kind === "dir" && dst.entries!.size > 0) return "ENOTEMPTY";
    } else if (!this.dirRoom(b.dir, b.name)) return "ENOSPC";

    a.dir.entries!.delete(a.name);
    if (dstIno !== undefined) {
      const dst = this.inodes.get(dstIno)!;
      b.dir.entries!.delete(b.name);
      if (dst.kind === "dir") { dst.nlink = 0; b.dir.nlink--; } else dst.nlink--;
      dst.ctime = this.tick();
      this.dropIfDead(dst);
    }
    if (src.kind === "dir" && a.dir !== b.dir) { a.dir.nlink--; b.dir.nlink++; src.parent = b.dir.ino; }
    src.ctime = this.tick();
    a.dir.mtime = a.dir.ctime = this.tick();
    this.addEntry(b.dir, b.name, src.ino);
    return null;
  }

  /** open(2): holds the inode in memory. Returns the inode number. */
  open(path: string): number | FsError {
    const r = this.resolve(path);
    if (typeof r === "string") return r;
    this.inodes.get(r)!.openCount++;
    return r;
  }

  close(ino: number): FsError | null {
    const n = this.inodes.get(ino);
    if (!n || n.openCount === 0) return "EBADF";
    n.openCount--;
    this.dropIfDead(n);
    return null;
  }

  /** pwrite by path: allocates a block only for the bytes touched, so untouched ranges stay holes. */
  write(path: string, offset: number, len: number): FsError | null {
    const r = this.resolve(path);
    if (typeof r === "string") return r;
    return this.writeIno(r, offset, len);
  }

  writeIno(ino: number, offset: number, len: number): FsError | null {
    const n = this.inodes.get(ino);
    if (!n) return "EBADF";
    if (n.kind === "dir") return "EISDIR";
    if (len <= 0) return null;
    const first = Math.floor(offset / this.blockSize);
    const last = Math.floor((offset + len - 1) / this.blockSize);
    let need = 0;
    for (let l = first; l <= last; l++) if (!n.map.has(l)) need++;
    if (need > this.freeBlocks) return "ENOSPC";
    for (let l = first; l <= last; l++) if (!n.map.has(l)) n.map.set(l, this.allocBlock(n.ino));
    n.size = Math.max(n.size, offset + len);
    n.mtime = n.ctime = this.tick();
    return null;
  }

  /** truncate(2): grows with a hole, or frees the blocks past the new end. */
  truncate(path: string, size: number): FsError | null {
    const r = this.resolve(path);
    if (typeof r === "string") return r;
    const n = this.inodes.get(r)!;
    if (n.kind === "dir") return "EISDIR";
    const keep = Math.ceil(size / this.blockSize);
    for (const [l, b] of [...n.map]) if (l >= keep) { this.freeBlock(b); n.map.delete(l); }
    n.size = size;
    n.mtime = n.ctime = this.tick();
    return null;
  }

  stat(path: string, follow = true): Stat | FsError {
    const r = this.resolve(path, follow);
    if (typeof r === "string") return r;
    return this.statIno(r);
  }

  statIno(ino: number): Stat {
    const n = this.inodes.get(ino)!;
    return { ino: n.ino, kind: n.kind, mode: n.mode, uid: n.uid, gid: n.gid, nlink: n.nlink, size: n.size, blocks512: (n.map.size * this.blockSize) / 512, blksize: this.blockSize, mtime: n.mtime, ctime: n.ctime };
  }

  /** Every name in the tree, depth first. */
  list(): { path: string; name: string; depth: number; ino: number; kind: InodeKind }[] {
    const out: { path: string; name: string; depth: number; ino: number; kind: InodeKind }[] = [];
    const go = (dir: Inode, prefix: string, depth: number) => {
      for (const name of [...dir.entries!.keys()].sort()) {
        const ino = dir.entries!.get(name)!;
        const n = this.inodes.get(ino)!;
        const path = `${prefix}/${name}`;
        out.push({ path, name, depth, ino, kind: n.kind });
        if (n.kind === "dir") go(n, path, depth + 1);
      }
    };
    go(this.inodes.get(ROOT_INO)!, "", 0);
    return out;
  }

  /** A small fsck: returns each rule that the current state breaks. */
  check(): string[] {
    const bad: string[] = [];
    const links = new Map<number, number>();
    const seen = new Set<number>();
    const stack = [ROOT_INO];
    links.set(ROOT_INO, 2);
    while (stack.length) {
      const dino = stack.pop()!;
      seen.add(dino);
      const d = this.inodes.get(dino);
      if (!d) { bad.push(`directory ${dino} is missing`); continue; }
      for (const [name, c] of d.entries!) {
        const n = this.inodes.get(c);
        if (!n) { bad.push(`${name} points at free inode ${c}`); continue; }
        links.set(c, (links.get(c) ?? 0) + 1);
        if (n.kind === "dir") {
          links.set(c, (links.get(c) ?? 0) + 1); // its own "."
          links.set(dino, (links.get(dino) ?? 0) + 1); // its ".."
          if (n.parent !== dino) bad.push(`directory ${c} has the wrong parent`);
          if (seen.has(c)) bad.push(`cycle at ${c}`);
          stack.push(c);
        } else seen.add(c);
      }
    }
    let owned = 0;
    for (const n of this.inodes.values()) {
      const want = links.get(n.ino) ?? 0;
      if (n.nlink !== want) bad.push(`inode ${n.ino}: nlink ${n.nlink}, counted ${want}`);
      if (n.nlink === 0 && n.openCount === 0) bad.push(`inode ${n.ino}: dead but not freed`);
      if (want === 0 && !this.orphans.has(n.ino)) bad.push(`inode ${n.ino}: unreachable and not an orphan`);
      for (const b of n.map.values()) {
        if (this.owner[b] !== n.ino) bad.push(`block ${b}: owner ${this.owner[b]}, used by ${n.ino}`);
        owned++;
      }
    }
    if (owned !== this.usedBlocks) bad.push(`inodes own ${owned} blocks, the bitmap says ${this.usedBlocks}`);
    let marked = 0;
    for (let i = 0; i < this.totalBlocks; i++) if (this.owner[i] !== 0) marked++;
    if (marked !== this.usedBlocks) bad.push(`bitmap has ${marked} bits set, the counter says ${this.usedBlocks}`);
    return bad;
  }
}

// ----------------------------------------------------------------------------------------- ext4 on-disk layout

export interface Ext4LayoutOpts { blockSize?: number; inodeSize?: number; bytesPerInode?: number }

/** Default values of mke2fs for an ordinary file system. */
export const EXT4_DEFAULTS = { blockSize: 4096, inodeSize: 256, bytesPerInode: 16384, iBlockBytes: 60 };

/**
 * One block group. One block of block bitmap covers 8 * blockSize blocks, and this sets the size of a group.
 * The inode ratio then sets how many inodes the group gets.
 */
export function ext4Layout(o: Ext4LayoutOpts = {}) {
  const { blockSize, inodeSize, bytesPerInode } = { ...EXT4_DEFAULTS, ...o };
  const blocksPerGroup = blockSize * 8;
  const groupBytes = blocksPerGroup * blockSize;
  const inodesPerGroup = groupBytes / bytesPerInode;
  const inodeTableBlocks = Math.ceil((inodesPerGroup * inodeSize) / blockSize);
  return {
    blockSize, inodeSize, bytesPerInode, blocksPerGroup, groupBytes, inodesPerGroup, inodeTableBlocks,
    inodeTableBytes: inodeTableBlocks * blockSize,
    /** Share of the disk that the inode tables take. fsck pass 1 must read all of it. */
    inodeTableFraction: inodeSize / bytesPerInode,
  };
}

// ----------------------------------------------------------------------------------------- the three tables

export interface OpenFile { id: number; ino: number; offset: number; refs: number; append: boolean }
export interface TableInode { ino: number; name: string; size: number; refs: number }
export interface Proc { pid: number; fds: Map<number, number> }

/**
 * Three tables. Each process has a table of small integers (files_struct). Each entry points at an open file
 * description (struct file), which holds the offset. Each description points at one inode (struct inode).
 */
export class OpenTables {
  readonly procs = new Map<number, Proc>();
  readonly files = new Map<number, OpenFile>();
  readonly inodes = new Map<number, TableInode>();
  private nextFile = 1;
  private nextPid = 100;

  constructor(paths: Record<string, { ino: number; size: number }>) {
    for (const [name, x] of Object.entries(paths)) this.inodes.set(x.ino, { ino: x.ino, name, size: x.size, refs: 0 });
    this.spawn();
  }

  spawn(): number {
    const pid = this.nextPid++;
    this.procs.set(pid, { pid, fds: new Map() });
    return pid;
  }

  /** The lowest free descriptor, starting at 3 because 0, 1 and 2 are the standard streams. */
  private lowestFd(p: Proc) {
    let fd = 3;
    while (p.fds.has(fd)) fd++;
    return fd;
  }

  /** open(2) always makes a new description with its own offset, even for a file that is already open. */
  open(pid: number, name: string, append = false): number | FsError {
    const p = this.procs.get(pid);
    if (!p) return "EINVAL";
    const ino = [...this.inodes.values()].find((i) => i.name === name);
    if (!ino) return "ENOENT";
    const f: OpenFile = { id: this.nextFile++, ino: ino.ino, offset: 0, refs: 1, append };
    this.files.set(f.id, f);
    ino.refs++;
    const fd = this.lowestFd(p);
    p.fds.set(fd, f.id);
    return fd;
  }

  /** dup(2): a new number for the same description, so the offset is shared. */
  dup(pid: number, fd: number): number | FsError {
    const p = this.procs.get(pid);
    const id = p?.fds.get(fd);
    if (!p || id === undefined) return "EBADF";
    this.files.get(id)!.refs++;
    const nfd = this.lowestFd(p);
    p.fds.set(nfd, id);
    return nfd;
  }

  /** fork(2): the child gets a copy of the fd table. Each entry points at the same description. */
  fork(pid: number): number | FsError {
    const p = this.procs.get(pid);
    if (!p) return "EINVAL";
    const child = this.spawn();
    const c = this.procs.get(child)!;
    for (const [fd, id] of p.fds) { c.fds.set(fd, id); this.files.get(id)!.refs++; }
    return child;
  }

  /** read(2) moves the shared offset. It returns the offset at which the read started. */
  read(pid: number, fd: number, n: number): number | FsError {
    const id = this.procs.get(pid)?.fds.get(fd);
    if (id === undefined) return "EBADF";
    const f = this.files.get(id)!;
    const at = f.offset;
    f.offset = Math.min(at + n, this.inodes.get(f.ino)!.size);
    return at;
  }

  /** write(2). With O_APPEND the kernel moves the offset to the end first. Returns the offset of the write. */
  write(pid: number, fd: number, n: number): number | FsError {
    const id = this.procs.get(pid)?.fds.get(fd);
    if (id === undefined) return "EBADF";
    const f = this.files.get(id)!;
    const ino = this.inodes.get(f.ino)!;
    if (f.append) f.offset = ino.size;
    const at = f.offset;
    f.offset = at + n;
    ino.size = Math.max(ino.size, f.offset);
    return at;
  }

  /** pwrite(2) writes at an explicit offset and leaves the shared offset alone. */
  pwrite(pid: number, fd: number, at: number, n: number): number | FsError {
    const id = this.procs.get(pid)?.fds.get(fd);
    if (id === undefined) return "EBADF";
    const f = this.files.get(id)!;
    const ino = this.inodes.get(f.ino)!;
    ino.size = Math.max(ino.size, at + n);
    return at;
  }

  close(pid: number, fd: number): FsError | null {
    const p = this.procs.get(pid);
    const id = p?.fds.get(fd);
    if (!p || id === undefined) return "EBADF";
    p.fds.delete(fd);
    const f = this.files.get(id)!;
    if (--f.refs === 0) {
      this.files.delete(id);
      this.inodes.get(f.ino)!.refs--;
    }
    return null;
  }

  /** Returns each broken rule: reference counts must equal the number of pointers. */
  check(): string[] {
    const bad: string[] = [];
    const fileRefs = new Map<number, number>();
    for (const p of this.procs.values()) for (const id of p.fds.values()) fileRefs.set(id, (fileRefs.get(id) ?? 0) + 1);
    for (const f of this.files.values()) if ((fileRefs.get(f.id) ?? 0) !== f.refs) bad.push(`file ${f.id}: refs ${f.refs}`);
    for (const id of fileRefs.keys()) if (!this.files.has(id)) bad.push(`fd points at dead file ${id}`);
    const inoRefs = new Map<number, number>();
    for (const f of this.files.values()) inoRefs.set(f.ino, (inoRefs.get(f.ino) ?? 0) + 1);
    for (const i of this.inodes.values()) if ((inoRefs.get(i.ino) ?? 0) !== i.refs) bad.push(`inode ${i.ino}: refs ${i.refs}`);
    return bad;
  }
}

export type TableOp =
  | { op: "open"; pid: number; name: string; append?: boolean }
  | { op: "dup"; pid: number; fd: number }
  | { op: "fork"; pid: number }
  | { op: "write"; pid: number; fd: number; n: number }
  | { op: "pwrite"; pid: number; fd: number; at: number; n: number }
  | { op: "close"; pid: number; fd: number };

/** Applies one table operation and describes it. Used by the three-tables stepper. */
export function applyTableOp(t: OpenTables, o: TableOp): { text: string; say: string; at?: number } {
  switch (o.op) {
    case "open": {
      const fd = t.open(o.pid, o.name, o.append);
      return { text: `pid ${o.pid}: fd = open("${o.name}"${o.append ? ", O_APPEND" : ""})`, say: `open returned fd ${String(fd)}. It made a new description with offset 0.` };
    }
    case "dup": {
      const fd = t.dup(o.pid, o.fd);
      return { text: `pid ${o.pid}: dup(${o.fd})`, say: `dup returned fd ${String(fd)}. It points at the same description, so it shares the offset.` };
    }
    case "fork": {
      const c = t.fork(o.pid);
      return { text: `pid ${o.pid}: fork()`, say: `The child, pid ${String(c)}, got a copy of the fd table. Each entry points at the same description, and each reference count grew.` };
    }
    case "write": {
      const at = t.write(o.pid, o.fd, o.n);
      return { text: `pid ${o.pid}: write(fd ${o.fd}, ${o.n} bytes)`, say: `The write landed at offset ${String(at)}.`, at: typeof at === "number" ? at : undefined };
    }
    case "pwrite": {
      const at = t.pwrite(o.pid, o.fd, o.at, o.n);
      return { text: `pid ${o.pid}: pwrite(fd ${o.fd}, ${o.n} bytes, at ${o.at})`, say: `The write landed at offset ${String(at)}. The shared offset did not move.`, at: typeof at === "number" ? at : undefined };
    }
    case "close": {
      t.close(o.pid, o.fd);
      return { text: `pid ${o.pid}: close(${o.fd})`, say: "The fd entry went away, and the description lost one reference." };
    }
  }
}

export interface TableScenario { id: string; label: string; files: Record<string, { ino: number; size: number }>; ops: TableOp[] }

export const TABLE_SCENARIOS: TableScenario[] = [
  {
    id: "two-opens", label: "Two opens", files: { "log.txt": { ino: 12, size: 0 } },
    ops: [
      { op: "open", pid: 100, name: "log.txt" }, { op: "open", pid: 100, name: "log.txt" },
      { op: "write", pid: 100, fd: 3, n: 100 }, { op: "write", pid: 100, fd: 4, n: 100 },
    ],
  },
  {
    id: "dup", label: "dup", files: { "log.txt": { ino: 12, size: 0 } },
    ops: [
      { op: "open", pid: 100, name: "log.txt" }, { op: "dup", pid: 100, fd: 3 },
      { op: "write", pid: 100, fd: 3, n: 100 }, { op: "write", pid: 100, fd: 4, n: 100 },
    ],
  },
  {
    id: "fork", label: "fork", files: { "log.txt": { ino: 12, size: 0 } },
    ops: [
      { op: "open", pid: 100, name: "log.txt" }, { op: "fork", pid: 100 },
      { op: "write", pid: 100, fd: 3, n: 100 }, { op: "write", pid: 101, fd: 3, n: 100 },
      { op: "close", pid: 101, fd: 3 }, { op: "write", pid: 100, fd: 3, n: 100 },
    ],
  },
  {
    id: "fork-open", label: "fork, then open", files: { "log.txt": { ino: 12, size: 0 } },
    ops: [
      { op: "fork", pid: 100 }, { op: "open", pid: 100, name: "log.txt" }, { op: "open", pid: 101, name: "log.txt" },
      { op: "write", pid: 100, fd: 3, n: 100 }, { op: "write", pid: 101, fd: 3, n: 100 },
    ],
  },
  {
    id: "append", label: "Two opens, O_APPEND", files: { "log.txt": { ino: 12, size: 0 } },
    ops: [
      { op: "open", pid: 100, name: "log.txt", append: true }, { op: "open", pid: 100, name: "log.txt", append: true },
      { op: "write", pid: 100, fd: 3, n: 100 }, { op: "write", pid: 100, fd: 4, n: 100 },
    ],
  },
];

/** Runs a scenario and returns the offsets at which its writes landed. */
export function scenarioWrites(s: TableScenario): number[] {
  const t = new OpenTables(s.files);
  const out: number[] = [];
  for (const o of s.ops) {
    const r = applyTableOp(t, o);
    if (r.at !== undefined) out.push(r.at);
  }
  return out;
}
