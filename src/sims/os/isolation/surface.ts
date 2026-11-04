/**
 * How much of the system call surface a program needs, and how much a profile removes.
 * The table holds common x86-64 calls with their real numbers, grouped by area. It is a model input: the full table has
 * more calls, and the counts in the lesson are counts of this table.
 */
export interface Sys { name: string; nr: number; group: SysGroup }
export type SysGroup = "file" | "memory" | "process" | "signal" | "time" | "network" | "ipc" | "admin" | "sandbox";

const T = (group: SysGroup, s: string): Sys[] => s.trim().split(/\s+/).map((x) => {
  const [name, nr] = x.split(":");
  return { name: name!, nr: Number(nr), group };
});

export const SYSCALLS: Sys[] = [
  ...T("file", `read:0 write:1 open:2 close:3 stat:4 fstat:5 lstat:6 lseek:8 pread64:17 pwrite64:18 readv:19 writev:20 access:21 dup:32 dup2:33 sendfile:40 fcntl:72 flock:73 fsync:74 fdatasync:75 truncate:76 ftruncate:77 getdents64:217 getcwd:79 chdir:80 rename:82 mkdir:83 rmdir:84 link:86 unlink:87 symlink:88 readlink:89 chmod:90 chown:92 umask:95 openat:257 newfstatat:262 unlinkat:263 faccessat:269 statx:332 ioctl:16 poll:7 select:23 epoll_create1:291 epoll_ctl:233 epoll_wait:232 epoll_pwait:281 eventfd2:290 pipe2:293 inotify_init1:294 inotify_add_watch:254 io_uring_setup:425 io_uring_enter:426 io_uring_register:427`),
  ...T("memory", `mmap:9 mprotect:10 munmap:11 brk:12 mremap:25 msync:26 madvise:28 mlock:149 memfd_create:319 mbind:237 set_mempolicy:238 get_mempolicy:239 move_pages:279 userfaultfd:323 process_vm_readv:310 process_vm_writev:311`),
  ...T("process", `clone:56 fork:57 vfork:58 execve:59 exit:60 wait4:61 getpid:39 getppid:110 gettid:186 getuid:102 geteuid:107 getgid:104 getegid:108 setuid:105 setgid:106 setgroups:116 prlimit64:302 arch_prctl:158 prctl:157 set_tid_address:218 set_robust_list:273 rseq:334 futex:202 sched_yield:24 sched_getaffinity:204 sched_setaffinity:203 exit_group:231 getrandom:318 uname:63 getrusage:98 clone3:435 execveat:322 ptrace:101`),
  ...T("signal", `rt_sigaction:13 rt_sigprocmask:14 rt_sigreturn:15 kill:62 tgkill:234 sigaltstack:131 rt_sigsuspend:130 signalfd4:289 pidfd_open:434`),
  ...T("time", `nanosleep:35 clock_nanosleep:230 clock_gettime:228 gettimeofday:96 timerfd_create:283 timerfd_settime:286 settimeofday:164 clock_settime:227 clock_adjtime:305 adjtimex:159`),
  ...T("network", `socket:41 connect:42 accept:43 accept4:288 bind:49 listen:50 getsockname:51 getpeername:52 socketpair:53 setsockopt:54 getsockopt:55 sendto:44 recvfrom:45 sendmsg:46 recvmsg:47 shutdown:48 sendmmsg:307 recvmmsg:299`),
  ...T("ipc", `shmget:29 shmat:30 shmctl:31 semget:64 semop:65 msgget:68 msgsnd:69 msgrcv:70 mq_open:240`),
  ...T("admin", `mount:165 umount2:166 swapon:167 swapoff:168 reboot:169 sethostname:170 init_module:175 finit_module:313 delete_module:176 kexec_load:246 kexec_file_load:320 acct:163 quotactl:179 iopl:172 ioperm:173 perf_event_open:298 bpf:321 add_key:248 request_key:249 keyctl:250 open_by_handle_at:304 name_to_handle_at:303 syslog:103 personality:135 pivot_root:155 chroot:161 mknod:133 fanotify_init:300 nfsservctl:180 lookup_dcookie:212`),
  ...T("sandbox", `seccomp:317 unshare:272 setns:308 landlock_create_ruleset:444 landlock_add_rule:445 landlock_restrict_self:446 capset:126 capget:125`),
];

export const SYS_BY_NAME = new Map(SYSCALLS.map((s) => [s.name, s]));
export const nrOf = (name: string): number => {
  const s = SYS_BY_NAME.get(name);
  if (!s) throw new Error(`unknown system call ${name}`);
  return s.nr;
};

/** What a dynamically linked glibc program calls before main, on a recent Linux. */
const STARTUP = "execve brk mmap mprotect munmap openat read close fstat newfstatat pread64 arch_prctl set_tid_address set_robust_list rseq prlimit64 getrandom access";
const list = (s: string) => s.trim().split(/\s+/);

export interface SampleProgram { id: string; label: string; startup: string[]; main: string[] }
export const PROGRAMS: SampleProgram[] = [
  { id: "hello", label: "hello world (C)", startup: list(STARTUP), main: list("write fstat exit_group") },
  { id: "filter", label: "Image decoder", startup: list(STARTUP), main: list("read write mmap munmap exit_group futex rt_sigreturn") },
  { id: "web", label: "Static file server", startup: list(STARTUP), main: list(`socket setsockopt bind listen accept4 epoll_create1 epoll_ctl epoll_wait read write writev sendfile close openat fstat newfstatat futex clock_gettime rt_sigaction rt_sigprocmask rt_sigreturn getpid getsockname shutdown exit_group`) },
  { id: "go", label: "Go HTTP service", startup: list("execve mmap munmap read close openat fcntl arch_prctl sched_getaffinity rt_sigaction rt_sigprocmask sigaltstack gettid"), main: list(`clone futex nanosleep epoll_create1 epoll_ctl epoll_pwait eventfd2 socket setsockopt bind listen accept4 getsockname read write madvise tgkill getpid rt_sigreturn sched_yield exit_group`) },
];

/** The calls that Docker's documentation lists as blocked by its default profile, as far as this table holds them, plus io_uring, which newer profiles block. */
const DOCKER_BLOCKS = list(`mount umount2 swapon swapoff reboot init_module finit_module delete_module kexec_load kexec_file_load acct quotactl iopl ioperm perf_event_open bpf add_key request_key keyctl open_by_handle_at settimeofday clock_settime clock_adjtime pivot_root setns unshare userfaultfd process_vm_readv process_vm_writev mbind set_mempolicy get_mempolicy move_pages nfsservctl lookup_dcookie io_uring_setup io_uring_enter io_uring_register`);

export type ProfileId = "none" | "docker" | "strict" | "allow";
export const PROFILES: { id: ProfileId; label: string }[] = [
  { id: "none", label: "No filter" },
  { id: "docker", label: "Docker-style deny list" },
  { id: "allow", label: "Allow list for this program" },
  { id: "strict", label: "Strict mode" },
];

export function profileAllows(id: ProfileId, program: SampleProgram, phase: "all" | "main" = "all"): Set<string> {
  const all = SYSCALLS.map((s) => s.name);
  if (id === "none") return new Set(all);
  if (id === "docker") return new Set(all.filter((n) => !DOCKER_BLOCKS.includes(n)));
  if (id === "strict") return new Set(["read", "write", "exit", "rt_sigreturn"]);
  return new Set(phase === "main" ? program.main : [...program.startup, ...program.main]);
}

export interface SurfaceReport {
  total: number;
  allowed: number;
  removed: number;
  removedFraction: number;
  needs: number;
  /** Calls the program needs that this profile would stop. */
  broken: string[];
  /** Calls that the profile leaves open and the program never uses. */
  unusedOpen: number;
}

export function surfaceReport(id: ProfileId, program: SampleProgram, phase: "all" | "main" = "all"): SurfaceReport {
  const allow = profileAllows(id, program, phase);
  const needs = new Set(phase === "main" ? program.main : [...program.startup, ...program.main]);
  const total = SYSCALLS.length;
  const allowed = SYSCALLS.filter((s) => allow.has(s.name)).length;
  const broken = [...needs].filter((n) => !allow.has(n));
  return { total, allowed, removed: total - allowed, removedFraction: (total - allowed) / total, needs: needs.size, broken, unusedOpen: SYSCALLS.filter((s) => allow.has(s.name) && !needs.has(s.name)).length };
}

/** Docker's documentation says that its default profile disables around this many calls out of more than 300. */
export const DOCKER_DOC_BLOCKED = 44;
