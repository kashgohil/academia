/**
 * The two-dimensional page walk under nested paging (EPT on Intel, NPT on AMD, stage 2 on arm64).
 * realNestedWalk uses two real PageTable objects from ../vm: a guest table whose frames are guest physical
 * addresses, and a host table that maps each guest physical page. Every read is recorded in order.
 */
import { PageTable, nestedWalkReads, PAGE_SIZE, SIZE_1G, SIZE_2M, splitVa, type Levels, TableMem } from "../vm";

export { nestedWalkReads };

export type NestedPageSize = "4k" | "2m" | "1g";
export const NESTED_SIZE: Record<NestedPageSize, number> = { "4k": PAGE_SIZE, "2m": SIZE_2M, "1g": SIZE_1G };

export interface NestedRead {
  /** 1-based order of the read. */
  n: number;
  /** "host": a read of a host table. "guest": a read of a guest table entry. */
  kind: "host" | "guest";
  /** Column in the grid: which guest step this serves. The last column is the final data address. */
  col: number;
  /** Row in the grid: the host level, or the last row for a guest read. */
  row: number;
  label: string;
  /** The host physical address of the entry read. */
  hpa: bigint;
}

export interface NestedWalk {
  reads: NestedRead[];
  /** Guest table levels used. */
  guestDepth: number;
  /** Host table levels used per translation. */
  hostDepth: number;
  colNames: string[];
  rowNames: string[];
  dataHpa: bigint;
  gpa: bigint;
}

export interface NestedSpec { guestLevels?: Levels; hostLevels?: Levels; guestPage?: NestedPageSize; hostPage?: NestedPageSize }

const VA = 0x00007f12_3456_7000n;

/** Builds the two page tables and performs one full translation of a guest virtual address. */
export function realNestedWalk(spec: NestedSpec = {}): NestedWalk {
  const gl = spec.guestLevels ?? 4, hl = spec.hostLevels ?? 4;
  const gs = NESTED_SIZE[spec.guestPage ?? "4k"], hs = NESTED_SIZE[spec.hostPage ?? "4k"];
  // Guest tables live in guest physical frames from 0x1000 up. Host tables live in host frames from 0x800000 up.
  const guest = new PageTable({ levels: gl, mem: new TableMem(0x1000) });
  const host = new PageTable({ levels: hl, mem: new TableMem(0x800000) });
  // The guest maps VA to a guest physical data page, aligned for the page size.
  const dataGfn = 0x40000;
  const va = (VA >> BigInt(Math.log2(gs))) << BigInt(Math.log2(gs));
  guest.map(va, dataGfn, { writable: true, size: gs });

  // The host maps each guest physical page that the walk touches, at a fixed offset in host frames.
  const hostFramesPerPage = hs / PAGE_SIZE;
  const HOST_OFFSET = 0x100000;
  const mapped = new Set<number>();
  const mapGfn = (gfn: number) => {
    const base = Math.floor(gfn / hostFramesPerPage) * hostFramesPerPage;
    if (mapped.has(base)) return;
    mapped.add(base);
    host.map(BigInt(base) * BigInt(PAGE_SIZE), HOST_OFFSET * hostFramesPerPage + base, { writable: true, size: hs });
  };

  const reads: NestedRead[] = [];
  const hostWalk = (gpa: bigint, col: number, what: string): bigint => {
    const w = host.walk(gpa, { user: true }, { readOnly: true });
    if (!w.ok) throw new Error(`EPT violation at ${gpa.toString(16)}`);
    w.events.forEach((e, row) => reads.push({ n: reads.length + 1, kind: "host", col, row, label: `Host ${e.name}: translate the guest physical address of ${what}`, hpa: e.entryPa }));
    return w.pa!;
  };

  // The real guest walk, by hand: each table address is a guest physical address.
  const { indices } = splitVa(va, gl);
  const names = guest.levels === 4 ? ["PML4", "PDPT", "PD", "PT"] : ["PML5", "PML4", "PDPT", "PD", "PT"];
  const colNames: string[] = [];
  let table = guest.root;
  let dataGpa = 0n;
  let col = 0;
  // Every host translation has the same depth, because all host mappings use one page size.
  mapGfn(guest.root);
  const rootWalk = host.walk(BigInt(guest.root) * BigInt(PAGE_SIZE), { user: true }, { readOnly: true });
  const hostDepth = rootWalk.events.length;
  const rowNames = rootWalk.events.map((e) => e.name);
  for (let l = 0; l < gl; l++) {
    mapGfn(table);
    const name = names[l]!;
    colNames.push(name);
    const tableGpa = BigInt(table) * BigInt(PAGE_SIZE);
    const tableHpa = hostWalk(tableGpa, col, `the guest ${name}`);
    const entry = guest.mem.read(table, indices[l]!);
    const entryHpa = tableHpa + BigInt(indices[l]! * 8);
    reads.push({ n: reads.length + 1, kind: "guest", col, row: hostDepth, label: `Guest ${name}: read entry ${indices[l]} of the guest table`, hpa: entryHpa });
    const isLeaf = l === gl - 1 || (entry & (1n << 7n)) !== 0n;
    const pfn = Number((entry & 0x000fffff_fffff000n) >> 12n);
    col++;
    if (isLeaf) {
      const pageMask = BigInt(gs - 1);
      dataGpa = BigInt(pfn) * BigInt(PAGE_SIZE) + (va & pageMask);
      break;
    }
    table = pfn;
  }
  colNames.push("data");
  mapGfn(Number(dataGpa >> 12n));
  const dataHpa = hostWalk(dataGpa, col, "the data page");
  return { reads, guestDepth: col, hostDepth, colNames, rowNames: [...rowNames, "guest entry"], dataHpa, gpa: dataGpa };
}

/** Native walk reads for the same guest depth, with no second dimension. */
export const nativeReads = (guestDepth: number) => nestedWalkReads(guestDepth, 0);
