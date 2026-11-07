/**
 * Networking, Programming: the models behind "Sockets", "select, poll and epoll", "io_uring for networking" and
 * "Zero copy". They build on the reference TCP (../transport) and on the OS track's cost inputs (../../os).
 *
 * - sockets.ts: `SocketWorld` (a PacketNet with a TcpStack and receive hooks), `ListenSocket` (the SYN queue and the
 *   accept queue with Linux overflow rules), `acceptQueueRun` (a burst against a slow server), `lifecycleRun` (every
 *   API call with its return value: late accept, EPIPE and SIGPIPE, RST on close with unread data, lingering close),
 *   `streamRun` (short writes into a small send buffer, reads that ignore message boundaries), ephemeral port math.
 * - events.ts: `herdRun` (blocking accept, shared epoll, EPOLLEXCLUSIVE and SO_REUSEPORT: wakeups, balance and
 *   queue wait), `etAcceptRun` (level vs edge-triggered accept loops on real connects), `TimerHeap`.
 * - uring.ts: `bufRingRun` (multishot recv with a provided buffer ring, ENOBUFS and re-arming, on a PacketNet link),
 *   `recvBufferMemory`, `requestCost` (system calls and CPU per request for five server designs).
 * - zerocopy.ts: `COPY_PATHS` and `pathCost` (copies, DMA, encryption and calls for read/write, mmap, sendfile,
 *   splice, TLS, kTLS, MSG_ZEROCOPY and SEND_ZC), `zcSendCost` and `zcCrossover`, `zcHeldBytes`, `rxCores`.
 *
 * Constants named *_MODEL are model inputs. Constants named *_FACTS are real values.
 */
export * from "./sockets";
export * from "./events";
export * from "./uring";
export * from "./zerocopy";
