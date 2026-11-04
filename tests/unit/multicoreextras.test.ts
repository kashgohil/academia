/** Pins every number that the four multicore lessons quote, and checks the extra models against the base sims. */
import { describe, expect, test } from "vitest";
import {
  replayEvents, transitionEdges, falseSharing, falseSharingFrames, workloadStats, LINE_BYTES,
  route, hops, diameter, gridDims, networkSummary, messagesPerTransaction,
  directoryStep, directoryRun, sbTimeline, countSchedules,
  accessPath, numaFlows, pageMap, threadSlot, CORES_PER_SOCKET, NUMA_DEFAULTS,
  type CohEvent, type NetTopology,
} from "@/sims/multicoreextras";
import { Coherence } from "@/sims/coherence";
import { avgHops, links } from "@/sims/interconnect";
import { simulateNuma, type Placement } from "@/sims/numa";
import { parse } from "@/sims/memmodel";
import { PRESETS } from "@/sims/memmodel/presets";
import { mulberry32 } from "@/sims/rng";

// ---------------------------------------------------------------- cache-coherence-mesi

describe("coherence lesson", () => {
  const states = (p: "MSI" | "MESI" | "MOESI", ev: CohEvent[]) => replayEvents(p, ev).steps.map((s) => s.to);
  test("read then write: MSI 2 bus transactions, MESI 1", () => {
    expect(replayEvents("MSI", ["myRead", "myWrite"]).coh.busTransactions).toBe(2);
    expect(replayEvents("MESI", ["myRead", "myWrite"]).coh.busTransactions).toBe(1);
    expect(states("MESI", ["myRead", "myWrite"])).toEqual(["E", "M"]);
    expect(states("MSI", ["myRead", "myWrite"])).toEqual(["S", "M"]);
  });
  test("other core reads a Modified line: MESI writes back (M → S), MOESI keeps it dirty (M → O)", () => {
    const mesi = replayEvents("MESI", ["myRead", "myWrite", "otherRead"]);
    expect(mesi.steps.at(-1)!.to).toBe("S");
    expect(mesi.coh.memValue(0)).toBe(1);
    const moesi = replayEvents("MOESI", ["myRead", "myWrite", "otherRead"]);
    expect(moesi.steps.at(-1)!.to).toBe("O");
    expect(moesi.coh.memValue(0)).toBe(0); // memory stays stale
  });
  test("another core's write invalidates this copy from any state", () => {
    for (const p of ["MSI", "MESI", "MOESI"] as const)
      for (const e of transitionEdges(p).filter((x) => x.ev === "otherWrite")) expect(e.to, `${p} ${e.from}`).toBe("I");
  });
  test("a write in O needs a BusUpgr", () => {
    const s = replayEvents("MOESI", ["myWrite", "otherRead", "myWrite"]).steps;
    expect(s[1]!.to).toBe("O");
    expect(s[2]!.bus).toBe("BusUpgr");
    expect(s[2]!.to).toBe("M");
  });
  test("the state machine has the expected edges", () => {
    const has = (p: "MSI" | "MESI" | "MOESI", from: string, to: string, ev: CohEvent) => transitionEdges(p).some((e) => e.from === from && e.to === to && e.ev === ev);
    expect(has("MESI", "E", "M", "myWrite")).toBe(true);
    expect(transitionEdges("MESI").find((e) => e.from === "E" && e.to === "M")!.bus).toBeNull();
    expect(transitionEdges("MSI").some((e) => e.to === "E")).toBe(false);
    expect(has("MOESI", "M", "O", "otherRead")).toBe(true);
    expect(has("MOESI", "M", "S", "otherRead")).toBe(false);
  });
  test("workload numbers (4 cores)", () => {
    expect(workloadStats("private", 4, "MSI").bus).toBe(32);
    expect(workloadStats("private", 4, "MESI").bus).toBe(16);
    expect(workloadStats("producer-consumer", 4, "MESI").memWrites).toBe(8);
    expect(workloadStats("producer-consumer", 4, "MOESI").memWrites).toBe(0);
    const fs = workloadStats("false-sharing", 4, "MESI"), pad = workloadStats("padded", 4, "MESI");
    expect([fs.bus, pad.bus]).toEqual([63, 4]);
    expect(Number((fs.cycles / pad.cycles).toFixed(1))).toBe(3.6);
  });
  test("false sharing by distance: 31 vs 2 bus transactions, 1,154 vs 320 cycles, about 3.6 times", () => {
    expect(LINE_BYTES).toBe(64);
    const near = falseSharing(8), same = falseSharing(56), apart = falseSharing(64);
    expect([near.bus, apart.bus]).toEqual([31, 2]);
    expect([near.cycles, apart.cycles]).toEqual([1154, 320]);
    expect(same).toEqual(near);
    expect(falseSharing(128)).toEqual({ ...apart, sameLine: false });
    expect((near.cycles / apart.cycles).toFixed(1)).toBe("3.6");
    // At 64 bytes: one miss per core, then every access hits.
    const f = falseSharingFrames(64);
    expect(f.filter((x) => !x.hit).length).toBe(2);
    expect(f.slice(0, 4).map((x) => x.hit)).toEqual([false, true, false, true]);
    expect(f.slice(4).every((x) => x.hit)).toBe(true);
  });
});

// ---------------------------------------------------------------- interconnects

describe("interconnects lesson", () => {
  const T: NetTopology[] = ["ring", "mesh", "torus"];
  test("routes are valid walks and match the average hops of sims/interconnect", () => {
    for (const t of T)
      for (const n of [4, 9, 16, 25, 36, 64]) {
        const [r, c] = gridDims(n);
        let sum = 0;
        for (let a = 0; a < n; a++)
          for (let b = 0; b < n; b++) {
            const p = route(t, n, a, b);
            expect(p[0]).toBe(a);
            expect(p.at(-1)).toBe(b);
            for (let i = 1; i < p.length; i++) {
              const u = p[i - 1]!, v = p[i]!;
              if (t === "ring") expect(Math.min((u - v + n) % n, (v - u + n) % n)).toBe(1);
              else {
                const dr = Math.abs(Math.floor(u / c) - Math.floor(v / c)), dc = Math.abs((u % c) - (v % c));
                const wrap = t === "torus" && ((dr === r - 1 && dc === 0) || (dc === c - 1 && dr === 0));
                expect(dr + dc === 1 || wrap, `${t} ${n}: ${u}→${v}`).toBe(true);
              }
            }
            if (a !== b) sum += p.length - 1;
          }
        expect(sum / (n * (n - 1))).toBeCloseTo(avgHops(t, n), 9);
      }
  });
  test("numbers quoted in the lesson", () => {
    expect(avgHops("ring", 64).toFixed(2)).toBe("16.25");
    expect(avgHops("mesh", 64).toFixed(2)).toBe("5.33");
    expect(avgHops("ring", 16).toFixed(2)).toBe("4.27");
    expect(avgHops("mesh", 16).toFixed(2)).toBe("2.67");
    expect(hops("mesh", 16, 0, 15)).toBe(6);
    expect([diameter("mesh", 16), diameter("ring", 16), diameter("torus", 16)]).toEqual([6, 8, 4]);
    expect(networkSummary("mesh", 64)).toEqual({ avg: avgHops("mesh", 64), diameter: 14, links: 112 });
    expect([links("ring", 64), links("torus", 64)]).toEqual([64, 128]);
  });
  test("messages per transaction: directory 2 (private) and about 4 (shared counter); snooping 63 at 64 cores", () => {
    const priv = messagesPerTransaction("private", 64);
    expect(priv).toEqual({ snoopLookups: 63, directory: 2 });
    expect(Math.round(messagesPerTransaction("shared-counter", 64).directory)).toBe(4);
  });
  test("directory messages match the counter in sims/coherence", () => {
    for (const p of ["MSI", "MESI", "MOESI"] as const) {
      const r = mulberry32(11);
      const coh = new Coherence(6, 4, p);
      for (let i = 0; i < 2000; i++) {
        const before = coh.c.dirMsgs, bus = coh.busTransactions;
        const s = directoryStep(coh, Math.floor(r() * 6), r() < 0.4 ? "W" : "R", i + 1);
        expect(s.msgs.length, `${p} step ${i}`).toBe(coh.c.dirMsgs - before);
        expect(s.busTransaction).toBe(coh.busTransactions > bus);
      }
    }
  });
  test("directory demo scripts", () => {
    const all = directoryRun(8, "MESI", [...Array.from({ length: 8 }, (_, k) => ({ core: k, op: "R" as const })), { core: 0, op: "W" }]);
    const last = all.steps.at(-1)!;
    expect(last.msgs.length).toBe(16);
    expect(last.msgs.filter((m) => m.kind === "invalidate").length).toBe(7);
    expect(last.msgs.filter((m) => m.kind === "ack").length).toBe(7);
    expect(all.steps.length).toBe(9);
    expect([all.dirMsgs, all.snoopLookups]).toEqual([33, 63]);
    const turns = directoryRun(8, "MESI", [2, 5, 2, 5].map((core) => ({ core, op: "W" as const })));
    expect(turns.steps.map((s) => s.msgs.length)).toEqual([2, 5, 5, 5]);
    expect(turns.steps[1]!.msgs.map((m) => m.kind)).toEqual(["request", "forward", "data", "invalidate", "ack"]);
    const wr = directoryRun(8, "MESI", [{ core: 3, op: "W" }, { core: 6, op: "R" }]);
    expect(wr.steps[1]!.msgs).toEqual([
      { from: 6, to: "home", kind: "request" },
      { from: "home", to: 3, kind: "forward" },
      { from: 3, to: 6, kind: "data" },
      { from: 3, to: "home", kind: "writeback" },
    ]);
  });
});

// ---------------------------------------------------------------- memory-consistency-models

describe("consistency lesson", () => {
  test("timeline numbers", () => {
    expect(sbTimeline(8, 2, false).r).toEqual([0, 0]);
    expect(sbTimeline(3, 2, false).r[1]).toBe(1);
    const f = sbTimeline(8, 2, true);
    expect(f.weak).toBe(false);
    expect(f.stall).toEqual([7, 7]);
  });
  test("rule: both read 0 exactly when the store time exceeds the start delay plus 1; never with a fence or with no buffer", () => {
    for (let drain = 0; drain <= 30; drain++)
      for (let gap = 0; gap <= 12; gap++) {
        expect(sbTimeline(drain, gap, false).weak, `${drain},${gap}`).toBe(drain > gap + 1);
        expect(sbTimeline(drain, gap, true).weak).toBe(false);
      }
    for (let gap = 0; gap <= 12; gap++) expect(sbTimeline(0, gap, false).weak).toBe(false);
  });
  const run = (id: string, mode: "sc" | "tso" | "pso") => countSchedules(parse(PRESETS[id]!.src), mode);
  const count = (r: ReturnType<typeof run>, regs: string) => r.outcomes.find((o) => o.key.startsWith(regs + " "))?.count ?? 0;
  test("schedule counts", () => {
    const sc = run("sb-relaxed", "sc"), tso = run("sb-relaxed", "tso");
    expect([sc.schedules, count(sc, "r0=0 r1=0")]).toEqual([6, 0]);
    expect([tso.schedules, count(tso, "r0=0 r1=0")]).toEqual([80, 18]);
    expect(count(run("mp-relaxed", "tso"), "r0=1 r1=0")).toBe(0);
    const pso = run("mp-relaxed", "pso");
    expect([pso.schedules, count(pso, "r0=1 r1=0")]).toEqual([45, 1]);
    const fence = run("sb-fence-sc", "tso");
    expect([fence.schedules, count(fence, "r0=0 r1=0")]).toEqual([70, 0]);
  });
  test("each witness schedule really produces its outcome", async () => {
    const SB = await import("@/sims/storebuffer");
    for (const id of ["sb-relaxed", "mp-relaxed", "mp-one-fence", "sb-fence-sc"])
      for (const mode of ["sc", "tso", "pso"] as const) {
        const p = parse(PRESETS[id]!.src);
        for (const o of countSchedules(p, mode).outcomes) {
          let s = SB.initial(p);
          for (const st of o.witness) {
            if (st.kind === "exec") s = SB.exec(p, s, st.core, mode);
            else s = SB.drain(s, st.core, s.cores[st.core]!.buf.findIndex((e) => e.loc === st.loc && e.val === st.val), mode);
          }
          expect(SB.finished(p, s)).toBe(true);
          expect(SB.outcomeOf(p, s)).toBe(o.key);
        }
        // the same outcome set as the exhaustive search in sims/storebuffer
        expect(new Set(countSchedules(p, mode).outcomes.map((o) => o.key))).toEqual(SB.allOutcomes(p, mode));
      }
  });
});

// ---------------------------------------------------------------- numa

describe("numa lesson", () => {
  const sim = (placement: Placement, sockets: number, threads: number) => simulateNuma({ ...NUMA_DEFAULTS, sockets, threads, placement });
  test("bandwidth and latency numbers", () => {
    expect(sim("serial-first-touch", 2, 16).gbps).toBe(60);
    expect(sim("parallel-first-touch", 2, 16).gbps).toBe(120);
    expect(sim("interleave", 2, 16).gbps).toBe(120);
    expect(sim("parallel-first-touch", 2, 16).latency).toBe(90);
    expect(sim("parallel-first-touch", 2, 16).remoteFraction).toBe(0);
    expect(sim("interleave", 2, 16).remoteFraction).toBe(0.5);
    expect(sim("interleave", 2, 16).latency).toBe(120);
    expect(sim("serial-first-touch", 4, 32).gbps).toBe(60);
    expect(sim("parallel-first-touch", 4, 32).gbps).toBe(240);
    expect(sim("serial-first-touch", 4, 32).gbps / (4 * NUMA_DEFAULTS.memBW)).toBe(0.25);
    const ratio = NUMA_DEFAULTS.latRemote / NUMA_DEFAULTS.latLocal;
    expect(ratio).toBeGreaterThanOrEqual(1.5);
    expect(ratio).toBeLessThanOrEqual(2);
  });
  test("with 6 threads or fewer the cores are the limit, so placement does not change bandwidth", () => {
    for (let t = 1; t <= 6; t++) {
      const g = (["serial-first-touch", "parallel-first-touch", "interleave"] as const).map((p) => sim(p, 2, t).gbps);
      expect(new Set(g).size, `${t} threads`).toBe(1);
      expect(sim("serial-first-touch", 2, t).bottleneck).toBe("cores");
    }
    expect(sim("serial-first-touch", 2, 7).gbps).toBeLessThan(sim("parallel-first-touch", 2, 7).gbps);
  });
  test("page map: remote fractions match simulateNuma", () => {
    for (const s of [2, 4])
      for (let n = 2; n <= 16; n += 2)
        for (const p of ["serial-first-touch", "parallel-first-touch", "interleave"] as const)
          expect(pageMap(s, n, p).remoteFraction, `${s} ${n} ${p}`).toBeCloseTo(sim(p, s, n).remoteFraction, 12);
    for (let n = 2; n <= 16; n += 2) {
      expect(pageMap(2, n, "serial-first-touch").remoteFraction).toBe(0.5);
      expect(pageMap(2, n, "parallel-first-touch").remoteFraction).toBe(0);
      expect(pageMap(2, n, "interleave").remoteFraction).toBe(0.5);
      expect(pageMap(4, n, "interleave").remoteFraction).toBe(0.75);
    }
  });
  test("one access: local 90 ns, remote 150 ns; 16 cores get 60 GB/s local, 40 GB/s remote", () => {
    expect(CORES_PER_SOCKET).toBe(16);
    expect(accessPath(0, 1).latency).toBe(150);
    expect(accessPath(0, 1).linkHops).toBe(1);
    expect(accessPath(0, 0).latency).toBe(90);
    expect(accessPath(0, 0).gbps).toBe(NUMA_DEFAULTS.coreBW);
    expect(accessPath(0, 0, 16)).toMatchObject({ gbps: 60, bottleneck: "memory controller" });
    expect(accessPath(0, 1, 16)).toMatchObject({ gbps: 40, bottleneck: "interconnect link" });
  });
  test("flows behind the 3D view", () => {
    const serial = numaFlows({ ...NUMA_DEFAULTS, sockets: 2, threads: 16, placement: "serial-first-touch" });
    expect(serial.links.find((l) => l.from === 0 && l.to === 1)!.gbps).toBe(30);
    expect(serial.nodes[0]!.util).toBe(1);
    const par = numaFlows({ ...NUMA_DEFAULTS, sockets: 2, threads: 16, placement: "parallel-first-touch" });
    expect(par.links.every((l) => l.gbps === 0)).toBe(true);
    const il = numaFlows({ ...NUMA_DEFAULTS, sockets: 4, threads: 16, placement: "interleave" });
    expect(il.links.length).toBe(12);
    for (const l of il.links) expect(l.gbps).toBeCloseTo(10, 9);
    // Consistency with simulateNuma for every configuration the demo offers.
    for (const s of [2, 4])
      for (let n = 1; n <= 32; n++)
        for (const p of ["serial-first-touch", "parallel-first-touch", "interleave"] as const) {
          const f = numaFlows({ ...NUMA_DEFAULTS, sockets: s, threads: n, placement: p });
          expect(f.threads.reduce((a, t) => a + t.gbps, 0)).toBeCloseTo(f.res.gbps, 9);
          for (const l of f.links) expect(l.util).toBeLessThanOrEqual(1 + 1e-9);
          for (const x of f.nodes) expect(x.util).toBeLessThanOrEqual(1 + 1e-9);
          for (const t of f.threads) expect(t.core).toBeLessThan(CORES_PER_SOCKET);
        }
    expect(threadSlot(5, 2)).toEqual({ socket: 1, core: 2 });
  });
});
