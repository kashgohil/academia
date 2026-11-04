/** Signals: delivery, masks, frames, restart rules, merging, and the handler that deadlocks. */
import { describe, expect, test } from "vitest";
import {
  AFTER_READ, HANDLER_VARIANTS, MACOS_SIGNAL_NUMBERS, READ_LINE, SIG, SIGNAL_FACTS, SigPending, SignalTask,
  canCatch, coalesceRun, defaultAction, handlerAction, handlerProg, isRealtime, pickThread, sigName, zombiesLeft,
} from "../../src/sims/os/ipc";
import { explore, machineModel, replay } from "../../src/sims/os/sync/machine";
import { mulberry32 } from "../../src/sims/rng";

const until = (t: SignalTask, stop: (t: SignalTask) => boolean, max = 200) => {
  for (let i = 0; i < max && !stop(t); i++) if (!t.step()) break;
};

function sleepingInRead(restart = false) {
  const t = new SignalTask();
  t.sigaction(SIG.SIGUSR1, handlerAction({ restart }));
  until(t, (x) => x.phase === "sleeping");
  expect(t.phase).toBe("sleeping");
  return t;
}

describe("facts", () => {
  test("numbers and default actions", () => {
    expect(SIGNAL_FACTS.standardCount).toBe(31);
    expect(SIGNAL_FACTS.glibcRtCount).toBe(31);
    expect(SIGNAL_FACTS.glibcSigRtMin).toBe(34);
    expect(SIGNAL_FACTS.sigRtMax).toBe(64);
    expect(SIGNAL_FACTS.redZoneBytes).toBe(128);
    expect(SIGNAL_FACTS.rtSigreturnX86).toBe(15);
    expect(SIGNAL_FACTS.rtSigreturnArm64).toBe(139);
    expect(SIGNAL_FACTS.goPreemptMs).toBe(10);
    expect(SIG.SIGKILL).toBe(9);
    expect(SIG.SIGSEGV).toBe(11);
    expect(SIG.SIGPIPE).toBe(13);
    expect(SIG.SIGTERM).toBe(15);
    expect(SIG.SIGCHLD).toBe(17);
    expect(SIG.SIGURG).toBe(23);
    expect(SIGNAL_FACTS.goPreemptSignal).toBe(23);
    expect(SIGNAL_FACTS.shellBase + SIG.SIGPIPE).toBe(141);
    expect(SIGNAL_FACTS.shellBase + SIG.SIGKILL).toBe(137);
    expect(MACOS_SIGNAL_NUMBERS.SIGCHLD).toBe(20);
    expect(MACOS_SIGNAL_NUMBERS.SIGUSR1).toBe(30);
    expect(defaultAction(SIG.SIGTERM)).toBe("term");
    expect(defaultAction(SIG.SIGSEGV)).toBe("core");
    expect(defaultAction(SIG.SIGCHLD)).toBe("ign");
    expect(defaultAction(SIG.SIGURG)).toBe("ign");
    expect(defaultAction(SIG.SIGSTOP)).toBe("stop");
    expect(defaultAction(SIG.SIGCONT)).toBe("cont");
    expect(defaultAction(40)).toBe("term");
    for (let s = 1; s <= 31; s++) expect(defaultAction(s)).toBeTruthy();
    expect(sigName(36)).toBe("SIGRTMIN+2");
    expect(isRealtime(31)).toBe(false);
    expect(isRealtime(34)).toBe(true);
    expect(canCatch(SIG.SIGKILL)).toBe(false);
    expect(canCatch(SIG.SIGSTOP)).toBe(false);
    expect(() => new SignalTask().sigaction(SIG.SIGKILL, handlerAction())).toThrow();
  });
});

describe("a signal during a blocking read", () => {
  test("with no SA_RESTART, read returns -1 and EINTR", () => {
    const t = sleepingInRead(false);
    t.send(SIG.SIGUSR1);
    expect(t.phase).toBe("syscall-exit");
    expect(t.rax).toBe("-ERESTARTSYS");
    until(t, (x) => x.phase === "handler");
    expect(t.frames.length).toBe(1);
    expect(t.frames[0]!.savedRax).toBe("-EINTR");
    until(t, (x) => x.frames.length === 0 && x.phase === "user");
    expect(t.pc).toBe(AFTER_READ);
    expect(t.readReturned).toBe("-1");
    expect(t.handled.length).toBe(1);
  });
  test("with SA_RESTART, the frame saves the syscall again, and read sleeps again", () => {
    const t = sleepingInRead(true);
    const startRsp = t.rsp;
    t.send(SIG.SIGUSR1);
    until(t, (x) => x.phase === "handler");
    expect(t.frames[0]!.savedRip).toBe("main+0x20");
    expect(t.rsp).toBe(startRsp - SIGNAL_FACTS.redZoneBytes - 0x400);
    until(t, (x) => x.frames.length === 0 && x.phase === "user");
    expect(t.pc).toBe(READ_LINE);
    expect(t.rsp).toBe(startRsp);
    until(t, (x) => x.phase === "sleeping");
    t.dataArrives();
    until(t, (x) => x.phase === "finished");
    expect(t.readReturned).toBe("64");
  });
  test("a signal with an ignore action does not wake the sleeper", () => {
    const t = sleepingInRead();
    expect(t.send(SIG.SIGCHLD)).toBe("ignored");
    expect(t.phase).toBe("sleeping");
  });
  test("a blocked signal does not wake the sleeper. Unblocking delivers it.", () => {
    const t = sleepingInRead();
    t.sigprocmask("block", [SIG.SIGUSR1]);
    t.send(SIG.SIGUSR1);
    expect(t.phase).toBe("sleeping");
    expect(t.pending.has(SIG.SIGUSR1)).toBe(true);
    expect(t.handled.length).toBe(0);
    t.sigprocmask("unblock", [SIG.SIGUSR1]);
    expect(t.phase).toBe("syscall-exit");
    until(t, (x) => x.phase === "handler");
    expect(t.handled.length).toBe(1);
    expect(t.pending.size).toBe(0);
  });
});

describe("the frame", () => {
  test("the handler runs with its signal and sa_mask blocked, and sigreturn restores the old mask", () => {
    const t = new SignalTask();
    t.sigaction(SIG.SIGUSR1, handlerAction({ mask: [SIG.SIGUSR2] }));
    t.sigprocmask("block", [SIG.SIGTERM]);
    t.send(SIG.SIGUSR1);
    until(t, (x) => x.phase === "handler");
    expect(t.blocked).toEqual([SIG.SIGUSR1, SIG.SIGUSR2, SIG.SIGTERM]);
    expect(t.frames[0]!.savedBlocked).toEqual([SIG.SIGTERM]);
    until(t, (x) => x.frames.length === 0);
    expect(t.blocked).toEqual([SIG.SIGTERM]);
  });
  test("a signal during a handler pushes a second frame, and frames pop in order", () => {
    const t = new SignalTask();
    t.sigaction(SIG.SIGUSR1, handlerAction());
    t.sigaction(SIG.SIGUSR2, handlerAction());
    t.send(SIG.SIGUSR1);
    until(t, (x) => x.phase === "handler");
    t.step();
    const first = t.hpc;
    const rsp1 = t.rsp;
    t.send(SIG.SIGUSR2);
    until(t, (x) => x.frames.length === 2 && x.phase === "handler");
    expect(t.rsp).toBeLessThan(rsp1);
    expect(t.frames[1]!.sig).toBe(SIG.SIGUSR2);
    until(t, (x) => x.frames.length === 1 && x.phase === "handler");
    expect(t.rsp).toBe(rsp1);
    expect(t.hpc).toBe(first);
    until(t, (x) => x.frames.length === 0);
    expect(t.handled.map((q) => q.sig)).toEqual([SIG.SIGUSR1, SIG.SIGUSR2]);
  });
  test("a blocked signal waits until sigreturn clears the mask", () => {
    const t = new SignalTask();
    t.sigaction(SIG.SIGUSR1, handlerAction());
    t.send(SIG.SIGUSR1);
    until(t, (x) => x.phase === "handler");
    expect(t.send(SIG.SIGUSR1)).toBe("queued");
    expect(t.frames.length).toBe(1);
    until(t, (x) => x.handled.length === 2);
    expect(t.frames.length).toBe(1);
  });
  test("lowest number first when two signals are ready", () => {
    const t = new SignalTask();
    t.sigaction(SIG.SIGUSR1, handlerAction({ mask: [SIG.SIGUSR2] }));
    t.sigaction(SIG.SIGUSR2, handlerAction());
    t.sigprocmask("block", [SIG.SIGUSR1, SIG.SIGUSR2]);
    t.send(SIG.SIGUSR2);
    t.send(SIG.SIGUSR1);
    t.sigprocmask("unblock", [SIG.SIGUSR1, SIG.SIGUSR2]);
    until(t, (x) => x.handled.length === 1);
    expect(t.handled[0]!.sig).toBe(SIG.SIGUSR1);
  });
});

describe("default actions in the machine", () => {
  test("SIGTERM kills, SIGKILL ignores the mask", () => {
    const t = new SignalTask();
    t.send(SIG.SIGTERM);
    until(t, (x) => x.phase === "dead");
    expect(t.exitSignal).toBe(SIG.SIGTERM);
    const k = new SignalTask();
    k.sigprocmask("block", [SIG.SIGKILL]);
    expect(k.blocked).toEqual([]);
    until(k, (x) => x.phase === "sleeping");
    k.send(SIG.SIGKILL);
    until(k, (x) => x.phase === "dead");
    expect(k.exitSignal).toBe(SIG.SIGKILL);
  });
  test("SIGSTOP stops a sleeper, and SIGCONT restarts its read", () => {
    const t = new SignalTask();
    until(t, (x) => x.phase === "sleeping");
    t.send(SIG.SIGSTOP);
    until(t, (x) => x.phase === "stopped");
    t.send(SIG.SIGCONT);
    until(t, (x) => x.phase === "sleeping");
    expect(t.pc).toBe(READ_LINE);
  });
});

describe("property: the machine stays consistent under random events", () => {
  test("mask and stack balance; nothing is delivered while blocked", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = mulberry32(seed);
      const t = new SignalTask();
      const SIGS = [SIG.SIGUSR1, SIG.SIGUSR2, 40];
      for (const s of SIGS) t.sigaction(s, handlerAction({ restart: r() < 0.5, mask: r() < 0.5 ? [SIG.SIGUSR2] : [] }));
      const startRsp = t.rsp;
      let sent = 0;
      for (let i = 0; i < 300; i++) {
        const x = r();
        if (x < 0.15) { const s = SIGS[Math.floor(r() * 3)]!; if (t.send(s, i) !== "ignored") sent++; }
        else if (x < 0.2) t.dataArrives();
        else t.step();
        expect(t.rsp).toBe(t.frames.length ? t.frames[t.frames.length - 1]!.frameRsp : startRsp);
        for (let k = 1; k < t.frames.length; k++) expect(t.frames[k]!.frameRsp).toBeLessThan(t.frames[k - 1]!.frameRsp);
      }
      // Drain.
      t.dataArrives();
      for (let i = 0; i < 2000 && t.phase !== "finished"; i++) if (!t.step() && t.phase === "sleeping") t.dataArrives();
      expect(t.phase).toBe("finished");
      expect(t.frames.length).toBe(0);
      expect(t.blocked).toEqual([]);
      expect(t.rsp).toBe(startRsp);
      // Each send is handled or merged. Nothing else is possible.
      expect(t.handled.length + t.pending.merged + t.pending.size).toBe(sent);
    }
  });
});

describe("threads", () => {
  const threads = [{ id: 1, blocked: [SIG.SIGTERM] }, { id: 2, blocked: [] }, { id: 3, blocked: [] }];
  test("a process signal goes to the first thread that does not block it", () => {
    expect(pickThread(threads, SIG.SIGUSR1, { kind: "process" })).toBe(1);
    expect(pickThread(threads, SIG.SIGTERM, { kind: "process" })).toBe(2);
    expect(pickThread(threads.map((t) => ({ ...t, blocked: [SIG.SIGTERM] })), SIG.SIGTERM, { kind: "process" })).toBeNull();
    expect(pickThread(threads, SIG.SIGTERM, { kind: "thread", id: 3 })).toBe(3);
  });
});

describe("standard signals merge, real-time signals queue", () => {
  test("the pending structure", () => {
    const p = new SigPending();
    expect(p.add(SIG.SIGCHLD)).toBe("queued");
    expect(p.add(SIG.SIGCHLD)).toBe("merged");
    expect(p.count(SIG.SIGCHLD)).toBe(1);
    expect(p.add(40, 1)).toBe("queued");
    expect(p.add(40, 2)).toBe("queued");
    expect(p.count(40)).toBe(2);
    const q = p.peek([SIG.SIGCHLD])!;
    expect(q.value).toBe(1);
  });
  const base = { sends: 5, gap: 3, handlerTicks: 20, maskedTicks: 0 };
  test("quoted counts: 5 sends with a slow handler", () => {
    const std = coalesceRun({ ...base, sig: SIG.SIGCHLD });
    expect(std.handlerRuns).toBe(2);
    expect(std.merged).toBe(3);
    const rt = coalesceRun({ ...base, sig: 40 });
    expect(rt.handlerRuns).toBe(5);
    expect(rt.merged).toBe(0);
    expect(rt.events.filter((e) => e.kind === "start").map((e) => e.value)).toEqual([1, 2, 3, 4, 5]);
    expect(zombiesLeft(5, std.handlerRuns, false)).toBe(3);
    expect(zombiesLeft(5, std.handlerRuns, true)).toBe(0);
  });
  test("masked during all sends: one run only", () => {
    const std = coalesceRun({ ...base, sig: SIG.SIGCHLD, maskedTicks: 20 });
    expect(std.handlerRuns).toBe(1);
    expect(std.merged).toBe(4);
  });
  test("a fast handler sees all", () => {
    const std = coalesceRun({ sends: 5, gap: 10, handlerTicks: 2, maskedTicks: 0, sig: SIG.SIGCHLD });
    expect(std.handlerRuns).toBe(5);
  });
});

describe("the handler and the allocator lock", () => {
  const run = (v: (typeof HANDLER_VARIANTS)[number]["value"]) => explore(machineModel(handlerProg(v)));
  test("malloc in the handler can deadlock, and never corrupts", () => {
    const r = run("malloc");
    expect(r.stuck).not.toBeNull();
    expect(r.violation).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.stuck!.schedule).toEqual(["T0", "T1"]);
    const p = handlerProg("malloc");
    const trail = replay(machineModel(p), r.stuck!.schedule);
    expect(trail[trail.length - 1]!.mem.lock).toBe(1);
  });
  test("an allocator with no lock does not hang, and it corrupts", () => {
    const r = run("nolock");
    expect(r.stuck).toBeNull();
    expect(r.violation).not.toBeNull();
    expect(r.violation!.message).toContain("corrupt");
  });
  test("blocking the signal around malloc removes the problem at every arrival point", () => {
    const r = run("masked");
    expect(r).toMatchObject({ stuck: null, violation: null, trapped: 0, truncated: false });
  });
  test("a handler that only writes to a pipe is safe at every arrival point", () => {
    const r = run("self-pipe");
    expect(r).toMatchObject({ stuck: null, violation: null, trapped: 0, truncated: false });
  });
  test("quoted state counts", () => {
    expect(run("malloc").states).toBe(30);
    expect(run("masked").states).toBe(31);
    expect(run("self-pipe").states).toBe(29);
  });
});
