/**
 * What a container is: a process plus a list of primitives. containerView computes what the process sees for any
 * subset of primitives, using the other models in this folder. The "exposed" lines are classes of risk, not steps.
 */
import { DOCKER_DEFAULT_CAPS, CAP_COUNT } from "./caps";
import { PidWorld } from "./pidns";
import { toOutside } from "./uidmap";
import { SYSCALLS, PROGRAMS, surfaceReport } from "./surface";

export type PrimitiveId = "pid" | "mnt" | "uts" | "net" | "user" | "cgroup" | "caps" | "seccomp";
export interface Primitive { id: PrimitiveId; label: string; call: string; change: string; exposed: string }

/** In the order this lesson applies them. A real runtime does much the same; it applies seccomp near the end, since the runtime still needs its own calls. */
export const PRIMITIVES: Primitive[] = [
  { id: "user", label: "User namespace", call: "clone(CLONE_NEWUSER), then write uid_map", change: "UID 0 inside maps to an ordinary UID on the host.", exposed: "Root inside is root on the host. Any way out of the other layers lands with host root rights." },
  { id: "pid", label: "PID namespace", call: "clone(CLONE_NEWPID)", change: "The process is PID 1. It cannot name a process outside.", exposed: "The process can name and signal other processes of the same user, and read their /proc entries." },
  { id: "mnt", label: "Mount namespace and root file system", call: "clone(CLONE_NEWNS), overlay mount, pivot_root, new /proc", change: "/ is now the image. The host tree is gone from this mount table. ps reads the new /proc.", exposed: "The host file system is the root file system. Host secrets and config are readable if the UID allows it." },
  { id: "uts", label: "UTS and IPC namespaces", call: "clone(CLONE_NEWUTS | CLONE_NEWIPC)", change: "Own host name. Own System V and POSIX IPC objects.", exposed: "With privilege, it can change the host's name. It shares IPC objects with other processes on the host." },
  { id: "net", label: "Network namespace", call: "clone(CLONE_NEWNET), veth pair", change: "Own interfaces, ports, routes and loopback.", exposed: "It can bind host ports, reach services on the host loopback, and, with privilege, change host routes." },
  { id: "cgroup", label: "cgroups", call: "write the PID to cgroup.procs; memory.max, cpu.max, pids.max", change: "Memory, CPU and task count have limits.", exposed: "One workload can use all memory, CPU or PIDs, and starve its neighbors." },
  { id: "caps", label: "Capability drop", call: "capset, PR_CAPBSET_DROP", change: `Root keeps ${DOCKER_DEFAULT_CAPS.size} of ${CAP_COUNT} capabilities. CAP_SYS_ADMIN is gone.`, exposed: "Root inside keeps CAP_SYS_ADMIN and others. Those reach many kernel interfaces that are guarded by nothing else." },
  { id: "seccomp", label: "seccomp filter", call: "prctl(PR_SET_NO_NEW_PRIVS), seccomp(SECCOMP_SET_MODE_FILTER)", change: "Rarely used and risky system calls now fail.", exposed: "Every system call reaches the shared kernel. A bug in any of them is a way to the kernel." },
];

export const ALL_PRIMITIVES: readonly PrimitiveId[] = PRIMITIVES.map((p) => p.id);

/** The host model: a few processes, with the container's process as the last one. */
export const HOST_PROCS = ["systemd", "sshd", "postgres", "kubelet", "your-editor", "app"] as const;

/** The map that the lesson uses: UID 0 inside is 100000 on the host. */
export const REMAP = [{ inside: 0, outside: 100000, length: 65536 }];

export interface ContainerView {
  /** getpid() in the process. */
  pid: number;
  /** The number of processes that `ps` lists. */
  psCount: number;
  rootfs: string;
  hostname: string;
  interfaces: string;
  uidInside: number;
  uidOnHost: number;
  capCount: number;
  hasSysAdmin: boolean;
  syscalls: number;
  syscallsTotal: number;
  memoryLimit: string;
  pidsLimit: string;
  /** uname -r: the kernel is never a primitive. It is always the host's. */
  kernel: string;
  exposed: string[];
}

export function containerView(enabled: ReadonlySet<PrimitiveId>): ContainerView {
  const on = (p: PrimitiveId) => enabled.has(p);
  const world = new PidWorld();
  const root = [...world.procs.keys()][0]!;
  for (const name of HOST_PROCS.slice(1, -1)) world.clone(root, name);
  const app = world.clone(root, "app", { newPid: on("pid") });
  const appNs = world.procs.get(app)!.ns;
  // ps reads /proc. A PID namespace with no new /proc mount still shows the old view.
  const procNs = on("mnt") ? appNs : world.rootNs;
  const report = surfaceReport(on("seccomp") ? "docker" : "none", PROGRAMS[0]!);
  return {
    pid: world.pidIn(app, appNs)!,
    psCount: world.visibleFrom(procNs).length,
    rootfs: on("mnt") ? "the image (overlay)" : "the host's /",
    hostname: on("uts") ? "app-7f3c" : "host-01",
    interfaces: on("net") ? "lo, eth0 (veth)" : "lo, eth0, docker0, ...",
    uidInside: 0,
    uidOnHost: on("user") ? toOutside(REMAP, 0)! : 0,
    capCount: on("caps") ? DOCKER_DEFAULT_CAPS.size : CAP_COUNT,
    hasSysAdmin: !on("caps"),
    syscalls: report.allowed,
    syscallsTotal: SYSCALLS.length,
    memoryLimit: on("cgroup") ? "512 MiB" : "none",
    pidsLimit: on("cgroup") ? "256" : "none",
    kernel: "host kernel",
    exposed: PRIMITIVES.filter((p) => !on(p.id)).map((p) => p.exposed),
  };
}

/** The classes of container escape in the lesson, each with the layer that defends against it. */
export const ESCAPE_CLASSES = [
  { name: "Kernel bug", how: "All containers share one kernel, so a bug in a reachable kernel path crosses every namespace.", defense: "seccomp, patches, or a VM" },
  { name: "Too much privilege", how: "`--privileged`, or `CAP_SYS_ADMIN` given to a workload, removes most layers by choice.", defense: "Drop capabilities, use a user namespace" },
  { name: "Host resource exposed", how: "A mounted Docker socket or host path gives direct control of the host, with no bug.", defense: "Do not mount them" },
  { name: "Runtime bug", how: "The runtime works across the boundary with host rights while it sets up. A bug there can leak host files or descriptors.", defense: "Patch, rootless mode" },
  { name: "Sensitive kernel files", how: "Some files in /proc and /sys control the whole host. They are not namespaced.", defense: "Masked and read-only paths" },
] as const;
