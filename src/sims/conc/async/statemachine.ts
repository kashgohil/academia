/**
 * async/await desugared.
 *
 * - The compiler turns an async fn into a state machine: an enum with one variant for each suspension point (await),
 *   which holds the locals that are live across that await, plus the sub-future it waits on. stateLayout() computes
 *   the size of each variant and of the whole future with a simple layout model: a 1-byte tag, then the fields in
 *   order with their alignment. rustc can also overlap and reorder fields, so real sizes can differ a little; the
 *   model shows the rule that matters: the largest variant sets the size.
 * - pollTrace() steps that state machine: each poll runs from the current state until a sub-future is Pending.
 * - pinTrace() shows why a future that has been polled must not move: a field points into the future itself.
 * - taskMemory() compares the memory of N waiting tasks as futures, goroutines and OS threads.
 */

export interface Field { name: string; ty: string; bytes: number; align: number }

export interface StateVariant { name: string; line: number; fields: Field[]; note: string }

export interface Layout { variants: { name: string; bytes: number; fields: (Field & { offset: number })[] }[]; bytes: number; align: number }

const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;

export function stateLayout(vs: StateVariant[]): Layout {
  let maxAlign = 1;
  const variants = vs.map((v) => {
    let off = 1; // the tag
    const fields = v.fields.map((f) => {
      maxAlign = Math.max(maxAlign, f.align);
      off = alignUp(off, f.align);
      const g = { ...f, offset: off };
      off += f.bytes;
      return g;
    });
    return { name: v.name, bytes: off, fields };
  });
  const bytes = alignUp(Math.max(...variants.map((v) => v.bytes)), maxAlign);
  return { variants, bytes, align: maxAlign };
}

/** The example: a handler that reads a request, looks up a row and writes it back. */
export const HANDLER_CODE = [
  "async fn handle(sock: &mut TcpStream, db: &Db) -> io::Result<()> {",
  "    let mut buf = [0u8; 1024];",
  "    let n = sock.read(&mut buf).await?;",
  "    let key = parse_key(&buf[..n]);",
  "    let row = db.get(key).await?;",
  "    sock.write_all(&row).await?;",
  "    Ok(())",
  "}",
];
/** The same function with the buffer on the heap. */
export const HANDLER_CODE_VEC = HANDLER_CODE.map((l, i) => (i === 1 ? "    let mut buf = vec![0u8; 1024];" : l));

/** Lines of the awaits in HANDLER_CODE. */
export const AWAIT_LINES = [2, 4, 5];

const ref = (name: string, ty: string): Field => ({ name, ty, bytes: 8, align: 8 });

/**
 * The states of `handle`. Sizes of the sub-futures are model inputs of a plausible size: a read future holds the
 * stream reference and the buffer slice (8 + 16 bytes); the db future 48 bytes; write_all also a position (32).
 */
export function handlerStates(heapBuf: boolean): StateVariant[] {
  const buf: Field = heapBuf ? { name: "buf", ty: "Vec<u8>", bytes: 24, align: 8 } : { name: "buf", ty: "[u8; 1024]", bytes: 1024, align: 1 };
  return [
    { name: "Unresumed", line: 0, fields: [ref("sock", "&mut TcpStream"), ref("db", "&Db")], note: "Created, not polled yet. It holds only the arguments." },
    { name: "Suspend0", line: 2, fields: [ref("sock", "&mut TcpStream"), ref("db", "&Db"), buf, { name: "read_fut", ty: "Read<'_>", bytes: 24, align: 8 }], note: heapBuf ? "Waits for the read. buf is a Vec: 24 bytes here, 1 KiB on the heap." : "Waits for the read. buf is live, and read_fut points into it." },
    { name: "Suspend1", line: 4, fields: [ref("sock", "&mut TcpStream"), ref("db", "&Db"), { name: "get_fut", ty: "Get<'_>", bytes: 48, align: 8 }], note: "Waits for the database. buf and n are dead, so they are not stored." },
    { name: "Suspend2", line: 5, fields: [ref("sock", "&mut TcpStream"), { name: "row", ty: "Vec<u8>", bytes: 24, align: 8 }, { name: "write_fut", ty: "WriteAll<'_>", bytes: 32, align: 8 }], note: "Waits for the write. row is live because write_fut borrows it." },
    { name: "Returned", line: 6, fields: [], note: "Done. A poll now panics." },
  ];
}

export interface PollStep {
  poll: number;
  /** State before and after this poll. */
  from: string;
  to: string;
  /** Lines that ran, in order. */
  lines: number[];
  result: "Pending" | "Ready";
  text: string;
}

/**
 * The polls of `handle` when each await is ready at its first poll or not. `readyAtFirst[i]`: the i-th sub-future is
 * already complete when it is first polled (the data was there), so the same poll continues past it.
 */
export function pollTrace(readyAtFirst: [boolean, boolean, boolean]): PollStep[] {
  const steps: PollStep[] = [];
  const names = ["Unresumed", "Suspend0", "Suspend1", "Suspend2", "Returned"];
  let state = 0, poll = 0;
  // In state k (1..3), the sub-future k-1 was Pending; the next poll finds it Ready.
  while (state < 4) {
    poll++;
    const from = state;
    const lines: number[] = [];
    let line = state === 0 ? 1 : AWAIT_LINES[state - 1]!;
    if (state === 0) lines.push(1);
    let pending = false;
    for (;;) {
      if (state > 0 && lines.length === 0) lines.push(line); // resume: the await finishes
      // Run to the next await (or the end).
      const k = state === 0 ? 0 : state; // index of the next await
      if (state !== 0) {
        if (state === 3) { lines.push(6); state = 4; break; }
      }
      const nextAwait = AWAIT_LINES[k]!;
      for (let l = line + 1; l <= nextAwait; l++) lines.push(l);
      line = nextAwait;
      state = k + 1;
      if (!readyAtFirst[k]) { pending = true; break; }
      // Ready at once: continue in the same poll.
    }
    const uniq = lines.filter((l, i) => lines.indexOf(l) === i);
    steps.push({
      poll, from: names[from]!, to: names[state]!, lines: uniq, result: pending ? "Pending" : "Ready",
      text: pending
        ? `poll ${poll}: runs to line ${line + 1}. The sub-future is not ready, so it returns Pending and the state becomes ${names[state]}.`
        : `poll ${poll}: runs to the end and returns Ready.`,
    });
    if (!pending) break;
  }
  return steps;
}

// ---------------------------------------------------------------- why Pin

export interface PinFrame { action: string; base: number; bufAt: number; ptr: number | null; ok: boolean; text: string }

/**
 * The handler future with buf on the stack. After the first poll, read_fut holds a pointer to buf, inside the same
 * future. Moving the future copies its bytes to a new address, and the pointer still holds the old address.
 */
export function pinTrace(actions: ("poll" | "move")[], pinned: boolean): PinFrame[] {
  const BUF_OFFSET = 24; // after the tag, sock and db (stateLayout of Suspend0)
  let base = 0x1000, ptr: number | null = null, ok = true, next = 0x2000;
  const frames: PinFrame[] = [{ action: "create", base, bufAt: base + BUF_OFFSET, ptr, ok, text: "let fut = handle(&mut sock, &db); The future holds only its arguments." }];
  for (const a of actions) {
    if (a === "poll") {
      if (ptr === null) {
        ptr = base + BUF_OFFSET;
        frames.push({ action: "poll", base, bufAt: base + BUF_OFFSET, ptr, ok, text: `The first poll stores buf in the future and a pointer to it (0x${ptr.toString(16)}) in read_fut.` });
      } else {
        const good = ptr === base + BUF_OFFSET;
        if (!good) ok = false;
        frames.push({ action: "poll", base, bufAt: base + BUF_OFFSET, ptr, ok, text: good ? "The read writes through the pointer into buf. All is well." : `The read writes to 0x${ptr.toString(16)}, memory the future left. That is use after free.` });
      }
      continue;
    }
    if (pinned) {
      frames.push({ action: "move", base, bufAt: base + BUF_OFFSET, ptr, ok, text: "let f2 = f; moves only the Pin<Box<_>>, an 8-byte pointer. The future stays where it is, so a pointer into it stays valid." });
      continue;
    }
    base = next;
    next += 0x1000;
    frames.push({
      action: "move", base, bufAt: base + BUF_OFFSET, ptr, ok,
      text: ptr === null
        ? "The future moves before its first poll. No field points into it yet, so the move is safe."
        : `The future's bytes move to 0x${base.toString(16)}. buf moves with them, but read_fut still points to 0x${ptr.toString(16)}.`,
    });
  }
  return frames;
}

// ---------------------------------------------------------------- memory of waiting tasks

/**
 * Model inputs for the memory of one waiting task:
 * - A Rust task: the future's state, plus a task header (state word, vtable, scheduler links): about 64 bytes.
 * - A goroutine: its stack, 2 KiB at the start (Go's minimum since Go 1.4), doubled by copying while the deepest
 *   frame chain does not fit; plus the g struct, about 400 bytes.
 * - An OS thread: the stack pages that the thread touched (4 KiB pages), plus the kernel's stack for the thread
 *   (16 KiB on x86-64) and its task struct, about 10 KiB. Its 8 MiB stack reservation is virtual memory only.
 */
export const MEM_MODEL = { taskHeader: 64, goMinStack: 2048, gStruct: 400, page: 4096, kernelStack: 16384, taskStruct: 10240, threadReserve: 8 << 20 } as const;

export interface TaskMemory { future: number; goroutine: number; thread: number; threadVirtual: number }

/** Bytes for one waiting task. `stateBytes`: the future's size. `stackBytes`: the deepest stack the code uses. */
export function taskMemory(stateBytes: number, stackBytes: number): TaskMemory {
  let g = MEM_MODEL.goMinStack;
  while (g < stackBytes) g *= 2;
  return {
    future: alignUp(stateBytes + MEM_MODEL.taskHeader, 16),
    goroutine: g + MEM_MODEL.gStruct,
    thread: Math.max(1, Math.ceil(stackBytes / MEM_MODEL.page)) * MEM_MODEL.page + MEM_MODEL.kernelStack + MEM_MODEL.taskStruct,
    threadVirtual: MEM_MODEL.threadReserve,
  };
}
