/**
 * Reference models for the "I/O" module. The kernel module and other lessons may import them.
 *
 * - interrupts: irqTimeline (task, hard, softirq, ksoftirqd on one CPU), irqShares, rxGoodput (fluid receive path for
 *   interrupt per packet, coalescing and NAPI), rxRun (the same, packet by packet), pollVsIrq.
 * - device: ToyDevice (status, command and data registers with real timing), driver sequences, DescRing (e1000-style
 *   ring with head, tail, doorbell and completions).
 * - dma: pioVsDma, sgList, dmaMapSg (bounce buffers), DmaLine (map and sync on a non-coherent system), Iommu (a real
 *   page table walk and an IOTLB, with strict and lazy unmap), iotlbRun.
 * - block: submitBio (back, front and join merges), runElevator (a stepper on the disk model), schedRun (closed-loop runs of
 *   none, mq-deadline and BFQ on HDD and NVMe models).
 * - eventloop: serverCost (threads, select, poll, epoll as N grows), EpollSocket (level and edge), runReader, starvationRun.
 * - uring: IoRing (u32 head and tail, links, multishot, SQPOLL, CQ overflow), ioPathCost.
 *
 * Constants named *_MODEL are model inputs. Constants named *_FACTS are real values.
 */
export * from "./interrupts";
export {
  DRIVER_FACTS, STATUS, COMMAND, ToyDevice, statusText, replayDevice, sendActions, recvActions, pollsPerByte, DescRing,
  replayRing as replayDescRing, DOORBELL_MODEL, doorbellCostPerPacket,
} from "./device";
export type { DevProblem, DevLogEntry, DevAction, SlotState, RingSlot, RingAction } from "./device";
export * from "./dma";
export * from "./block";
export * from "./eventloop";
export * from "./uring";
