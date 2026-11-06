// Single source of truth for the whole curriculum.
// Levels: 1 Foundations · 2 Core · 3 Advanced · 4 Frontier

export type Level = 1 | 2 | 3 | 4;
export type Status = "live" | "planned";

export interface Lesson {
  slug: string;
  title: string;
  status: Status;
  path: string; // track/module/lesson
}
export interface Module {
  slug: string;
  title: string;
  level: Level;
  lessons: Lesson[];
}
export interface Track {
  slug: string;
  title: string;
  blurb: string;
  modules: Module[];
}

export const LEVELS: Record<Level, string> = {
  1: "Foundations",
  2: "Core",
  3: "Advanced",
  4: "Frontier",
};

/** Lessons with a written MDX page. Paths must match `src/content/lessons/<path>.mdx`. */
export const LIVE = new Set<string>([
  "electronics/transients/rc-charging-and-discharging",
  "statistics/limit-theorems/central-limit-theorem",
  "deep-learning/optimization/gradient-descent-on-loss-surfaces",
  "architecture/caches/locality",
  "distributed/foundations/failure-detectors",
  "distributed/foundations/failure-models",
  "distributed/foundations/the-eight-fallacies",
  "distributed/foundations/the-network-model-messages-delays-and-partitions",
  "distributed/foundations/timeouts-retries-and-idempotency",
  "distributed/foundations/why-distribute",
  "distributed/time/hybrid-logical-clocks",
  "distributed/time/lamport-clocks",
  "distributed/time/ntp-and-clock-synchronization",
  "distributed/time/physical-clocks-and-drift",
  "distributed/time/vector-clocks",
  "os/observability/ebpf",
  "os/observability/ptrace-and-strace",
  "os/observability/tracepoints-and-ftrace",
  "os/fs/block-allocation-and-extents",
  "os/fs/files-inodes-and-directories",
  "os/fs/journaling",
  "os/fs/log-structured-and-copy-on-write-filesystems",
  "os/fs/path-lookup-and-the-vfs",
  "os/fs/the-page-cache-and-writeback",
  "os/kernel/a-simple-allocator",
  "os/kernel/a-simple-scheduler",
  "os/kernel/booting",
  "os/kernel/interrupt-handling",
  "os/kernel/protected-mode-and-long-mode",
  "os/kernel/userspace",
  "os/isolation/cgroups",
  "os/isolation/containers",
  "os/isolation/namespaces",
  "os/isolation/seccomp-and-sandboxing",
  "os/isolation/users-permissions-and-capabilities",
  "os/isolation/virtual-machines-and-hypervisors",
  "os/ipc/pipes",
  "os/ipc/shared-memory",
  "os/ipc/signals",
  "os/ipc/unix-domain-sockets",
  "os/io/blocking-non-blocking-and-async-i-o",
  "os/io/device-drivers",
  "os/io/dma-and-the-iommu",
  "os/io/interrupts",
  "os/io/io-uring",
  "os/io/the-block-layer-and-i-o-schedulers",
  "os/vm/address-spaces",
  "os/vm/huge-pages",
  "os/vm/page-faults-and-demand-paging",
  "os/vm/paging-and-page-tables",
  "os/vm/the-tlb",
  "os/processes/context-switching",
  "os/processes/fork-and-exec",
  "os/processes/kernel-mode-and-user-mode",
  "os/processes/loading-a-program-elf-and-the-dynamic-linker",
  "os/processes/system-calls",
  "os/processes/threads",
  "os/processes/what-a-process-is",
  "os/sync/condition-variables",
  "os/sync/critical-sections",
  "os/sync/deadlock",
  "os/sync/futexes",
  "os/sync/locks-and-spinlocks",
  "os/sync/read-copy-update",
  "os/sync/semaphores",
  "os/scheduling/cfs-and-eevdf",
  "os/scheduling/fifo-sjf-round-robin",
  "os/scheduling/multilevel-feedback-queues",
  "os/scheduling/multiprocessor-scheduling",
  "os/scheduling/real-time-scheduling",
  "os/memory/copy-on-write",
  "os/memory/kernel-memory-allocators",
  "os/memory/mmap",
  "os/memory/page-replacement",
  "os/memory/swapping-and-the-oom-killer",
  "databases/engine/a-tiny-key-value-store-end-to-end",
  "databases/engine/architecture-of-an-embedded-engine",
  "databases/engine/crash-testing-the-engine",
  "databases/engine/sqlite-lmdb-and-rocksdb-compared",
  "databases/indexes/hash-indexes",
  "databases/indexes/inverted-indexes",
  "databases/indexes/secondary-and-covering-indexes",
  "databases/indexes/spatial-indexes-r-trees",
  "databases/indexes/tries-and-adaptive-radix-trees",
  "databases/query/external-sorting-and-aggregation",
  "databases/query/join-algorithms",
  "databases/query/query-compilation",
  "databases/query/relational-algebra",
  "databases/query/vectorized-execution",
  "databases/query/volcano-iterator-model",
  "databases/optimizer/cardinality-estimation",
  "databases/optimizer/cost-models",
  "databases/optimizer/join-ordering",
  "databases/optimizer/reading-query-plans",
  "databases/olap/column-stores",
  "databases/olap/compression",
  "databases/olap/late-materialization",
  "databases/olap/zone-maps-and-data-skipping",
  "databases/recovery/aries",
  "databases/recovery/checkpoints",
  "databases/recovery/group-commit",
  "databases/recovery/physical-logical-and-physiological-logging",
  "databases/recovery/write-ahead-logging",
  "databases/transactions/acid",
  "databases/transactions/isolation-levels-and-anomalies",
  "databases/transactions/mvcc-garbage-collection",
  "databases/transactions/mvcc",
  "databases/transactions/optimistic-concurrency-control",
  "databases/transactions/serializable-snapshot-isolation",
  "databases/transactions/two-phase-locking-and-deadlocks",
  "databases/lsm/bloom-filters",
  "databases/lsm/compaction-leveled-vs-tiered",
  "databases/lsm/memtables-and-sstables",
  "databases/lsm/tuning-an-lsm-tree",
  "databases/btrees/b-trees",
  "databases/btrees/bulk-loading-and-fill-factor",
  "databases/btrees/copy-on-write-b-trees",
  "databases/btrees/latch-crabbing-and-b-link-trees",
  "databases/storage/buffer-pools",
  "databases/storage/disks-vs-ssds",
  "databases/storage/durability-fsync-torn-writes-and-checksums",
  "databases/storage/heap-files-and-free-space-maps",
  "databases/storage/pages-and-slotted-records",
  "databases/storage/read-write-and-space-amplification",
  "performance/systems/i-o-performance",
  "performance/systems/latency-vs-throughput",
  "performance/systems/tail-latency",
  "performance/systems/queueing-theory-and-littles-law",
  "performance/concurrency/false-sharing",
  "performance/concurrency/contention",
  "performance/concurrency/lock-free-vs-locked-in-practice",
  "performance/cpu/branch-prediction-and-branchless-code",
  "performance/cpu/simd-by-hand",
  "performance/cpu/auto-vectorization",
  "performance/cpu/instruction-level-parallelism",
  "performance/memory/latency-numbers",
  "performance/memory/cache-friendly-code",
  "performance/memory/data-oriented-design",
  "performance/memory/struct-of-arrays-vs-array-of-structs",
  "performance/measurement/benchmarking-pitfalls",
  "performance/measurement/statistics-of-benchmarks",
  "performance/measurement/profilers",
  "performance/measurement/flame-graphs",
  "performance/measurement/hardware-performance-counters",
  "architecture/multicore/cache-coherence-mesi",
  "architecture/multicore/memory-consistency-models",
  "architecture/multicore/interconnects",
  "architecture/multicore/numa",
  "concurrency/atomics/atomic-operations",
  "concurrency/lock-free/lock-free-stack",
  "concurrency/lock-free/the-aba-problem",
  "concurrency/lock-free/hazard-pointers",
  "concurrency/lock-free/epoch-based-reclamation",
  "concurrency/lock-free/michael-scott-queue",
  "concurrency/atomics/compare-and-swap",
  "concurrency/atomics/memory-orderings-relaxed-acquire-release-seq-cst",
  "concurrency/atomics/fences",
  "concurrency/atomics/happens-before",
  "architecture/caches/cache-organization-and-access-patterns",
  "architecture/caches/write-policies",
  "architecture/caches/multi-level-caches",
  "architecture/caches/prefetching",
  "systems/allocators/bump-allocators",
  "systems/allocators/arena-allocators",
  "systems/allocators/pool-allocators",
  "systems/allocators/free-lists",
  "systems/allocators/buddy-allocator",
  "systems/allocators/slab-allocator",
  "systems/allocators/general-purpose-allocators",
  "systems/allocators/fragmentation",
]);

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

type ModuleDef = [title: string, level: Level, lessons: string[], slug?: string];

function track(slug: string, title: string, blurb: string, defs: ModuleDef[]): Track {
  return {
    slug,
    title,
    blurb,
    modules: defs.map(([mTitle, level, lessons, mSlug]) => {
      const ms = mSlug ?? slugify(mTitle);
      return {
        slug: ms,
        title: mTitle,
        level,
        lessons: lessons.map((l) => {
          const ls = slugify(l);
          const path = `${slug}/${ms}/${ls}`;
          return { slug: ls, title: l, path, status: LIVE.has(path) ? "live" : "planned" };
        }),
      };
    }),
  };
}

export const TRACKS: Track[] = [
  track("math", "Mathematics", "The language underneath everything else.", [
    ["Logic, sets and proof", 1, ["Propositional logic", "Quantifiers", "Sets and functions", "Proof by induction", "Proof by contradiction", "Relations and equivalence classes"]],
    ["Vectors and matrices", 1, ["Vectors as arrows and as lists", "Dot product and projection", "Matrices as linear maps", "Matrix multiplication as composition", "Determinant as signed volume", "Inverse and rank"], "vectors"],
    ["Linear algebra in depth", 2, ["Vector spaces and bases", "Change of basis", "Eigenvalues and eigenvectors", "Diagonalization", "Orthogonality and Gram-Schmidt", "Least squares", "Singular value decomposition", "Spectral theorem"], "linear-algebra"],
    ["Single-variable calculus", 1, ["Limits and continuity", "The derivative", "Chain rule", "Integrals as accumulation", "Fundamental theorem of calculus", "Taylor series"], "calculus"],
    ["Multivariable and vector calculus", 2, ["Partial derivatives", "Gradient and directional derivative", "Jacobian and Hessian", "Multiple integrals", "Divergence and curl", "Green, Stokes and Gauss theorems"], "vector-calculus"],
    ["Differential equations", 2, ["First-order ODEs", "Linear ODEs and characteristic equations", "Systems of ODEs and phase portraits", "Stability and equilibria", "Laplace transform", "PDEs: heat, wave and Laplace"]],
    ["Discrete math and combinatorics", 1, ["Counting principles", "Permutations and combinations", "Pigeonhole principle", "Recurrences", "Generating functions", "Inclusion-exclusion"], "discrete"],
    ["Graph theory", 2, ["Graphs, paths and cycles", "Trees and spanning trees", "Bipartite graphs and matching", "Planarity and coloring", "Flows and cuts", "Spectral graph theory"]],
    ["Numerical methods", 2, ["Floating point and rounding error", "Root finding: bisection and Newton", "Interpolation", "Numerical integration", "ODE solvers and stability", "Conditioning and numerical stability", "Iterative linear solvers"]],
    ["Optimization", 3, ["Convex sets and functions", "Gradient methods and convergence", "Newton and quasi-Newton methods", "Linear programming and simplex", "Lagrange multipliers and KKT", "Duality", "Stochastic optimization"]],
    ["Information theory", 3, ["Entropy", "Cross-entropy and KL divergence", "Mutual information", "Source coding and Huffman", "Channel capacity", "Rate-distortion"]],
    ["Complex analysis", 3, ["Complex numbers geometrically", "Euler's formula", "Holomorphic functions", "Contour integration", "Residues", "Conformal maps"]],
    ["Abstract algebra", 3, ["Groups and symmetry", "Subgroups and cosets", "Rings and ideals", "Finite fields", "Polynomials over finite fields", "Elliptic curve groups"]],
  ]),

  track("statistics", "Probability & Statistics", "Reasoning precisely under uncertainty.", [
    ["Probability foundations", 1, ["Sample spaces and events", "Axioms of probability", "Conditional probability", "Bayes' theorem", "Independence", "Paradoxes: Monty Hall, Simpson, birthday"], "probability"],
    ["Random variables and distributions", 1, ["Discrete random variables", "Continuous random variables and densities", "Expectation and variance", "Bernoulli, binomial, Poisson", "Normal, exponential, gamma, beta", "Joint distributions and covariance", "Transformations of random variables"], "distributions"],
    ["Limit theorems", 2, ["Markov and Chebyshev inequalities", "Law of large numbers", "Central limit theorem", "Heavy tails and when the CLT fails", "Concentration inequalities"]],
    ["Estimation", 2, ["Estimators, bias and variance", "Method of moments", "Maximum likelihood", "Fisher information and Cramér-Rao", "MAP estimation", "Sufficiency"]],
    ["Hypothesis testing", 2, ["Null and alternative hypotheses", "p-values and what they are not", "Type I and II errors and power", "t-tests and z-tests", "Chi-squared tests", "Multiple comparisons and FDR", "Confidence intervals"], "testing"],
    ["Regression", 2, ["Simple linear regression", "Multiple regression", "Residual diagnostics", "Regularization: ridge and lasso", "Logistic regression", "Generalized linear models"]],
    ["Resampling", 2, ["Bootstrap", "Permutation tests", "Cross-validation", "Jackknife"]],
    ["Bayesian inference", 3, ["Priors, likelihoods, posteriors", "Conjugate priors", "Bayesian updating step by step", "Markov chain Monte Carlo", "Hamiltonian Monte Carlo", "Hierarchical models", "Model comparison"], "bayesian"],
    ["Experimental design", 3, ["Randomization and control", "A/B testing", "Sample size and power analysis", "Sequential testing", "Multi-armed bandits"]],
    ["Time series", 3, ["Stationarity and autocorrelation", "AR, MA and ARIMA", "Seasonality and decomposition", "State-space models", "Forecast evaluation"]],
    ["Causal inference", 3, ["Correlation vs causation", "Potential outcomes", "Causal DAGs and d-separation", "The do-calculus", "Confounding and backdoor adjustment", "Instrumental variables", "Difference-in-differences"], "causal"],
    ["Stochastic processes", 4, ["Markov chains", "Stationary distributions", "Poisson processes", "Random walks", "Brownian motion", "Martingales"]],
  ]),

  track("ml", "Machine Learning", "Learning patterns from data, rigorously.", [
    ["The learning problem", 1, ["What it means to learn from data", "Train, validation and test sets", "Bias-variance tradeoff", "Overfitting and regularization", "Loss functions"], "basics"],
    ["Linear models", 1, ["Linear regression from scratch", "Gradient descent for regression", "Logistic regression", "Softmax regression", "Feature engineering"]],
    ["Trees and ensembles", 2, ["Decision trees and impurity", "Bagging and random forests", "Boosting and AdaBoost", "Gradient boosting", "XGBoost internals"]],
    ["Kernel methods", 2, ["Maximum margin classifiers", "Support vector machines", "The kernel trick", "Kernel ridge regression"], "kernels"],
    ["Unsupervised learning", 2, ["k-means", "Hierarchical clustering", "DBSCAN", "Gaussian mixture models and EM", "Anomaly detection"], "unsupervised"],
    ["Dimensionality reduction", 2, ["PCA", "Kernel PCA", "t-SNE", "UMAP", "Autoencoders as reducers"]],
    ["Evaluation", 2, ["Precision, recall and F1", "ROC and PR curves", "Calibration", "Class imbalance", "Leakage and validation pitfalls"]],
    ["Probabilistic models", 3, ["Naive Bayes", "Hidden Markov models", "Gaussian processes", "Variational inference", "Graphical models"]],
    ["Learning theory", 3, ["PAC learning", "VC dimension", "Rademacher complexity", "No free lunch", "Double descent"]],
    ["Recommender systems", 3, ["Collaborative filtering", "Matrix factorization", "Implicit feedback", "Two-tower retrieval"], "recsys"],
    ["Reinforcement learning", 3, ["Markov decision processes", "Dynamic programming: value and policy iteration", "Monte Carlo and TD learning", "Q-learning and SARSA", "Policy gradients", "Actor-critic", "Exploration strategies"], "rl"],
  ]),

  track("deep-learning", "Deep Learning & LLMs", "From a single neuron to large language models.", [
    ["Neural network basics", 1, ["The perceptron", "Multilayer networks", "Activation functions", "Universal approximation", "Backpropagation from scratch", "Automatic differentiation"], "basics"],
    ["Optimization", 2, ["Gradient descent on loss surfaces", "Learning rate schedules", "Momentum and Nesterov", "Adam and adaptive methods", "Batch size and generalization", "Loss landscape geometry"]],
    ["Making training work", 2, ["Weight initialization", "Batch and layer normalization", "Residual connections", "Dropout and regularization", "Vanishing and exploding gradients", "Debugging training runs"], "training"],
    ["Convolutional networks", 2, ["Convolution as weight sharing", "Pooling and receptive fields", "Classic architectures", "Visualizing learned features"], "cnn"],
    ["Sequence models", 2, ["Recurrent networks", "LSTMs and GRUs", "Sequence-to-sequence", "Teacher forcing"], "sequences"],
    ["Transformers", 3, ["Attention from first principles", "Multi-head self-attention", "Positional encodings and RoPE", "The transformer block", "Causal masking", "Building a tiny GPT"]],
    ["Language modeling", 3, ["Tokenization and BPE", "Embeddings", "Next-token prediction", "Sampling: temperature, top-k, top-p", "Scaling laws", "Mixture of experts"], "llms"],
    ["Post-training", 3, ["Supervised fine-tuning", "LoRA and parameter-efficient tuning", "Reward models", "RLHF with PPO", "DPO", "Evaluations"]],
    ["Inference", 3, ["The KV cache", "Quantization", "FlashAttention", "Batching and paged attention", "Speculative decoding"]],
    ["Generative models", 4, ["Variational autoencoders", "GANs", "Normalizing flows", "Diffusion models", "Flow matching"]],
    ["Interpretability", 4, ["Probing representations", "Attribution methods", "Superposition", "Sparse autoencoders", "Circuits"]],
    ["Graph neural networks", 4, ["Message passing", "Graph convolutions", "Graph attention", "Over-smoothing"], "gnn"],
  ]),

  track("electronics", "Electronics", "Charge, fields, circuits and the chips built from them.", [
    ["DC circuits", 1, ["Charge, current and voltage", "Ohm's law and power", "Kirchhoff's laws", "Series, parallel and dividers", "Nodal and mesh analysis", "Thevenin and Norton equivalents", "Superposition"], "dc"],
    ["Transients", 1, ["Capacitors and stored energy", "Inductors and magnetic energy", "RC charging and discharging", "RL circuits", "RLC circuits and damping"]],
    ["AC circuits", 2, ["Sinusoids and phasors", "Impedance", "AC power and power factor", "Resonance", "Passive filters and Bode plots", "Transformers"], "ac"],
    ["Semiconductors", 2, ["Band theory and doping", "PN junction", "Diodes and rectifiers", "Zener diodes and regulation", "LEDs and photodiodes"]],
    ["Transistors", 2, ["BJT operation", "MOSFET operation", "Biasing", "Transistors as switches", "Small-signal models"]],
    ["Amplifiers", 2, ["Common-emitter and common-source", "Differential pairs", "Current mirrors", "Frequency response", "Noise"]],
    ["Op-amps", 2, ["The ideal op-amp", "Inverting and non-inverting amplifiers", "Summing, integrator, differentiator", "Active filters", "Comparators and Schmitt triggers", "Real op-amp limits"]],
    ["Feedback and oscillators", 3, ["Negative feedback", "Stability and phase margin", "Oscillators", "Phase-locked loops"], "feedback"],
    ["Digital logic", 1, ["Boolean algebra", "Logic gates from transistors", "Combinational circuits", "Adders and ALUs", "Latches and flip-flops", "Finite state machines", "Timing, setup and hold"], "digital"],
    ["Data conversion", 3, ["Sampling and quantization", "DAC architectures", "SAR ADCs", "Sigma-delta ADCs"]],
    ["Power electronics", 3, ["Linear regulators", "Buck converters", "Boost converters", "Inverters", "Motor drives"], "power"],
    ["RF and transmission lines", 4, ["Transmission line theory", "Reflections and impedance matching", "Smith charts", "Antennas", "Mixers"], "rf"],
    ["Signal integrity and PCB design", 3, ["Ground and return paths", "Decoupling", "Crosstalk", "Controlled impedance", "EMI"], "pcb"],
    ["Embedded systems", 2, ["Microcontroller architecture", "GPIO and debouncing", "Timers and PWM", "Interrupts", "UART, SPI and I2C", "DMA", "Low-power design"], "embedded"],
  ]),

  track("dsp", "Signals & DSP", "Seeing signals in time and frequency.", [
    ["Signals and systems", 1, ["Continuous and discrete signals", "Linearity and time invariance", "Impulse response", "Convolution", "Causality and stability"], "systems"],
    ["Fourier analysis", 2, ["Fourier series", "Fourier transform", "Frequency response", "Time-frequency uncertainty"], "fourier"],
    ["Sampling", 2, ["Sampling theorem", "Aliasing", "Reconstruction", "Quantization noise", "Oversampling"]],
    ["Discrete transforms", 2, ["DFT", "FFT algorithms", "Windowing and leakage", "Zero padding", "Short-time Fourier transform"], "dft"],
    ["The z-transform", 2, ["z-transform", "Poles and zeros", "Difference equations"], "z-transform"],
    ["Filter design", 3, ["FIR filters", "Window method", "IIR filters", "Bilinear transform", "Butterworth, Chebyshev and elliptic filters", "Filter stability and precision"], "filters"],
    ["Spectral estimation", 3, ["Periodogram", "Welch's method", "Parametric methods"], "spectral"],
    ["Communications", 3, ["AM and FM", "Digital modulation: ASK, FSK, PSK", "QAM and constellations", "OFDM", "Channel coding"], "comms"],
    ["Audio DSP", 3, ["Delay, echo and reverb", "Equalizers", "Pitch detection", "Synthesis"], "audio"],
    ["Image processing", 3, ["2D convolution and kernels", "Edge detection", "Morphology", "2D Fourier transform", "Image compression and the DCT"], "images"],
    ["Estimation and adaptive filtering", 4, ["Wiener filter", "LMS adaptive filters", "Kalman filter", "Extended and unscented Kalman", "Particle filters"], "estimation"],
    ["Wavelets", 4, ["Multiresolution analysis", "Haar and Daubechies wavelets", "Wavelet denoising"]],
  ]),

  track("control", "Control & Robotics", "Making systems do what you want, stably.", [
    ["Modeling dynamic systems", 1, ["Mass-spring-damper", "DC motor model", "Linearization", "Block diagrams"], "modeling"],
    ["Classical control", 2, ["Transfer functions", "Step response and specs", "PID control", "Tuning PID", "Root locus", "Bode and Nyquist", "Gain and phase margins"], "classical"],
    ["Digital control", 2, ["Discretization", "Sample rate effects", "Anti-windup"], "digital"],
    ["State-space control", 3, ["State-space models", "Controllability and observability", "Pole placement", "Observers", "LQR", "LQG"], "state-space"],
    ["Advanced control", 4, ["Model predictive control", "Nonlinear control and Lyapunov", "Adaptive control", "Robust control"], "advanced"],
    ["Robot kinematics", 2, ["Rigid transforms and frames", "Forward kinematics", "Inverse kinematics", "Jacobians and singularities"], "kinematics"],
    ["Motion planning", 3, ["Configuration space", "A* and Dijkstra on grids", "RRT and PRM", "Trajectory optimization"], "planning"],
    ["Localization and mapping", 3, ["Odometry", "Sensor fusion", "Particle filter localization", "SLAM"], "slam"],
  ]),

  track("physics", "Physics & Simulation", "The world as equations, and equations as code.", [
    ["Classical mechanics", 1, ["Kinematics", "Newton's laws", "Energy and momentum", "Rotation and torque", "Oscillations", "Orbits and gravity"], "mechanics"],
    ["Numerical integration", 2, ["Explicit Euler and its failures", "Semi-implicit Euler", "Verlet", "Runge-Kutta 4", "Symplectic integrators", "Stiffness"], "integrators"],
    ["Rigid bodies", 3, ["Inertia tensors", "Collision detection", "Collision response and impulses", "Constraints and joints"]],
    ["Soft bodies", 3, ["Mass-spring systems", "Cloth simulation", "Position-based dynamics", "Finite element basics"]],
    ["Fluids", 4, ["Navier-Stokes intuition", "Grid-based fluids", "Smoothed particle hydrodynamics", "Lattice Boltzmann"]],
    ["Waves", 2, ["Wave equation", "Interference and superposition", "Standing waves", "Doppler effect"]],
    ["Electromagnetism", 2, ["Electric fields", "Magnetic fields", "Maxwell's equations", "EM waves"], "em"],
    ["Thermodynamics and statistical mechanics", 3, ["Temperature and heat", "Laws of thermodynamics", "Entropy statistically", "Boltzmann distribution", "Ising model"], "thermo"],
    ["Quantum mechanics", 4, ["Wave-particle duality", "The Schrödinger equation", "Superposition and measurement", "Qubits", "Quantum gates and circuits", "Entanglement"], "quantum"],
  ]),

  track("architecture", "Computer Architecture", "How a CPU actually runs your code.", [
    ["Data representation", 1, ["Binary and hexadecimal", "Two's complement", "IEEE 754 floating point", "Endianness", "Character encoding and UTF-8"], "data"],
    ["Instruction sets", 1, ["What an ISA is", "RISC-V basics", "Addressing modes", "Calling conventions", "x86-64 and ARM compared"], "isa"],
    ["Datapath", 2, ["Single-cycle datapath", "Control unit", "Multi-cycle execution"]],
    ["Pipelining", 2, ["Five-stage pipeline", "Data hazards and forwarding", "Control hazards", "Branch prediction", "Superscalar issue"]],
    ["Caches", 2, ["Locality", "Cache organization and access patterns", "Write policies", "Multi-level caches", "Prefetching"]],
    ["Virtual memory", 2, ["Address translation", "Page tables", "TLBs", "Page faults"], "vm"],
    ["Out-of-order execution", 3, ["Register renaming", "Tomasulo's algorithm", "Reorder buffer", "Memory disambiguation", "Speculative execution"], "ooo"],
    ["Multicore", 3, ["Cache coherence: MESI", "Memory consistency models", "Interconnects", "NUMA"]],
    ["Parallel hardware", 3, ["SIMD and vector units", "GPU architecture", "Warps and divergence", "Tensor cores", "Systolic arrays"], "parallel"],
    ["Hardware design", 4, ["HDLs: Verilog basics", "Synthesis", "FPGAs", "Building a RISC-V core"], "hw-design"],
  ]),

  track("os", "Operating Systems", "The software that shares the machine.", [
    ["Processes and threads", 1, ["What a process is", "Kernel mode and user mode", "System calls", "fork and exec", "Loading a program: ELF and the dynamic linker", "Threads", "Context switching"], "processes"],
    ["Scheduling", 2, ["FIFO, SJF, round-robin", "Multilevel feedback queues", "CFS and EEVDF", "Real-time scheduling", "Multiprocessor scheduling"]],
    ["Virtual memory", 2, ["Address spaces", "Paging and page tables", "The TLB", "Page faults and demand paging", "Huge pages"], "vm"],
    ["Memory management", 3, ["Page replacement", "Swapping and the OOM killer", "Copy-on-write", "mmap", "Kernel memory allocators"], "memory"],
    ["Synchronization", 2, ["Critical sections", "Locks and spinlocks", "Futexes", "Semaphores", "Condition variables", "Read-copy-update", "Deadlock"], "sync"],
    ["File systems", 2, ["Files, inodes and directories", "Path lookup and the VFS", "Block allocation and extents", "Journaling", "Log-structured and copy-on-write filesystems", "The page cache and writeback"], "fs"],
    ["I/O", 2, ["Interrupts", "Device drivers", "DMA and the IOMMU", "The block layer and I/O schedulers", "Blocking, non-blocking and async I/O", "io_uring"], "io"],
    ["IPC", 2, ["Pipes", "Signals", "Shared memory", "Unix domain sockets"]],
    ["Isolation", 3, ["Users, permissions and capabilities", "Namespaces", "cgroups", "seccomp and sandboxing", "Containers", "Virtual machines and hypervisors"]],
    ["Observing the kernel", 3, ["ptrace and strace", "Tracepoints and ftrace", "eBPF"], "observability"],
    ["Writing a kernel", 4, ["Booting", "Protected mode and long mode", "Interrupt handling", "A simple allocator", "A simple scheduler", "Userspace"], "kernel"],
  ]),

  track("systems", "Systems Programming & Memory", "Owning every byte: layout, lifetimes, allocators.", [
    ["Memory model of a program", 1, ["Stack and heap", "Static data and the binary layout", "Pointers and references", "Struct layout, alignment and padding"], "memory"],
    ["Allocators", 2, ["Bump allocators", "Arena allocators", "Pool allocators", "Free lists", "Buddy allocator", "Slab allocator", "General-purpose allocators", "Fragmentation"]],
    ["Ownership and lifetimes", 2, ["Ownership in Rust", "Borrowing and the borrow checker", "Lifetimes", "RAII in C++", "Move semantics", "Smart pointers"], "ownership"],
    ["Explicit allocation styles", 2, ["Allocators as parameters in Zig", "Odin's context allocator", "Temporary allocators", "Defer and errdefer"], "explicit"],
    ["Compile-time programming", 3, ["Zig comptime", "C++ templates and constexpr", "Rust generics and traits", "Monomorphization costs"], "comptime"],
    ["Garbage collection", 3, ["Reference counting", "Mark and sweep", "Copying collectors", "Generational GC", "Concurrent GC and write barriers", "Go's GC"], "gc"],
    ["Linking and loading", 3, ["Object files and ELF", "Symbols and relocation", "Static and dynamic linking", "The dynamic loader"], "linking"],
    ["ABI and FFI", 3, ["Calling conventions", "Name mangling", "C ABI as lingua franca", "FFI across languages"], "abi"],
    ["Undefined behavior", 3, ["What UB really means", "Aliasing rules", "Integer overflow", "Sanitizers"], "ub"],
  ]),

  track("concurrency", "Concurrency & Parallelism", "Doing many things at once, correctly.", [
    ["Foundations", 1, ["Concurrency vs parallelism", "Race conditions", "Atomicity", "Amdahl's and Gustafson's laws"]],
    ["Locks", 2, ["Mutexes", "Reader-writer locks", "Condition variables", "Deadlock, livelock and starvation", "Lock contention"]],
    ["Atomics and memory ordering", 3, ["Atomic operations", "Compare-and-swap", "Memory orderings: relaxed, acquire, release, seq_cst", "Fences", "Happens-before"], "atomics"],
    ["Lock-free data structures", 4, ["Lock-free stack", "The ABA problem", "Hazard pointers", "Epoch-based reclamation", "Michael-Scott queue"], "lock-free"],
    ["Message passing", 2, ["CSP and channels", "Go channels and select", "Actor model", "Backpressure"]],
    ["Async", 3, ["Event loops", "Futures and promises", "async/await desugared", "Rust async runtimes", "Structured concurrency"]],
    ["Parallel patterns", 3, ["Fork-join", "Work stealing", "Map-reduce", "Pipelines", "False sharing"], "patterns"],
    ["Verification", 4, ["Linearizability", "Model checking", "TLA+ basics"]],
  ]),

  track("compilers", "Compilers & Languages", "From text to machine code.", [
    ["Lexing", 1, ["Tokens", "Regular expressions and finite automata", "Writing a lexer"]],
    ["Parsing", 2, ["Grammars", "Recursive descent", "Pratt parsing", "LL and LR parsing", "Error recovery"]],
    ["Semantic analysis", 2, ["Scopes and symbol tables", "Name resolution", "Type checking"], "semantics"],
    ["Type systems", 3, ["Static vs dynamic typing", "Type inference: Hindley-Milner", "Generics and polymorphism", "Subtyping", "Algebraic data types", "Linear and affine types"], "types"],
    ["Interpreters", 2, ["Tree-walking interpreters", "Bytecode design", "Stack vs register VMs", "Closures and upvalues"]],
    ["Intermediate representations", 3, ["Three-address code", "Control flow graphs", "SSA form", "Dominators"], "ir"],
    ["Optimization", 3, ["Constant folding and propagation", "Dead code elimination", "Inlining", "Loop optimizations", "Alias analysis"]],
    ["Code generation", 3, ["Instruction selection", "Register allocation: graph coloring", "Linear scan", "Instruction scheduling"], "codegen"],
    ["Runtimes", 4, ["JIT compilation", "Tracing JITs", "Inline caches", "GC integration"]],
    ["Metaprogramming", 3, ["Macros", "Hygiene", "Compile-time execution"], "meta"],
  ]),

  track("algorithms", "Algorithms & Data Structures", "The toolkit of efficient computation.", [
    ["Analysis", 1, ["Big-O and friends", "Amortized analysis", "Recurrences and the master theorem", "Lower bounds"]],
    ["Sorting and searching", 1, ["Binary search", "Insertion and merge sort", "Quicksort", "Heapsort", "Counting and radix sort"], "sorting"],
    ["Hashing", 2, ["Hash functions", "Chaining vs open addressing", "Robin Hood hashing", "Cuckoo hashing", "Swiss tables"]],
    ["Trees", 2, ["Binary search trees", "AVL trees", "Red-black trees", "B-trees", "Tries and radix trees", "Segment and Fenwick trees"]],
    ["Heaps and priority queues", 2, ["Binary heaps", "d-ary heaps", "Pairing and Fibonacci heaps"], "heaps"],
    ["Graph algorithms", 2, ["BFS and DFS", "Topological sort", "Dijkstra", "Bellman-Ford", "Minimum spanning trees", "Strongly connected components", "Max flow"], "graphs"],
    ["Algorithm design", 2, ["Divide and conquer", "Greedy algorithms", "Dynamic programming", "Backtracking"], "design"],
    ["Strings", 3, ["KMP", "Rabin-Karp", "Suffix arrays", "Edit distance"]],
    ["Probabilistic data structures", 3, ["Bloom filters", "Count-min sketch", "HyperLogLog", "Skip lists"], "probabilistic"],
    ["Memory-aware algorithms", 3, ["External memory model", "Cache-oblivious algorithms", "van Emde Boas layout"], "cache-aware"],
    ["Computational geometry", 3, ["Convex hull", "Line intersection", "Voronoi and Delaunay", "Spatial indexes: k-d trees, R-trees"], "geometry"],
    ["Complexity", 4, ["P vs NP", "Reductions", "NP-completeness", "Approximation algorithms"]],
  ]),

  track("databases", "Databases & Storage", "How data survives and gets found.", [
    ["Storage", 1, ["Disks vs SSDs", "Pages and slotted records", "Heap files and free-space maps", "Buffer pools", "Durability: fsync, torn writes and checksums", "Read, write and space amplification"]],
    ["B-trees", 2, ["B+ trees", "Bulk loading and fill factor", "Latch crabbing and B-link trees", "Copy-on-write B-trees"], "btrees"],
    ["LSM trees", 2, ["Memtables and SSTables", "Bloom filters", "Compaction: leveled vs tiered", "Tuning an LSM tree"], "lsm"],
    ["Transactions", 2, ["ACID", "Isolation levels and anomalies", "Two-phase locking and deadlocks", "Optimistic concurrency control", "MVCC", "Serializable snapshot isolation", "MVCC garbage collection"]],
    ["Recovery", 3, ["Write-ahead logging", "Group commit", "Physical, logical and physiological logging", "ARIES", "Checkpoints"]],
    ["More indexes", 2, ["Hash indexes", "Secondary and covering indexes", "Tries and adaptive radix trees", "Inverted indexes", "Spatial indexes: R-trees"], "indexes"],
    ["Query processing", 2, ["Relational algebra", "Volcano iterator model", "Join algorithms", "External sorting and aggregation", "Vectorized execution", "Query compilation"], "query"],
    ["Query optimization", 3, ["Cost models", "Cardinality estimation", "Join ordering", "Reading query plans"], "optimizer"],
    ["Analytical systems", 3, ["Column stores", "Compression", "Late materialization", "Zone maps and data skipping"], "olap"],
    ["Building a storage engine", 4, ["Architecture of an embedded engine", "A tiny key-value store, end to end", "Crash testing the engine", "SQLite, LMDB and RocksDB compared"], "engine"],
  ]),

  track("networking", "Networking", "Moving bytes between machines.", [
    ["Foundations", 1, ["Layers and encapsulation", "Packets and switching", "Latency, bandwidth and BDP"]],
    ["Link layer", 1, ["Ethernet", "ARP", "Switches and VLANs", "Wi-Fi"], "link"],
    ["Network layer", 2, ["IPv4 and IPv6", "Subnetting and CIDR", "Routing: distance-vector and link-state", "BGP", "NAT", "ICMP"], "ip"],
    ["Transport", 2, ["UDP", "TCP handshake and teardown", "Reliability and retransmission", "Flow control", "Congestion control: Reno and CUBIC", "BBR", "QUIC"]],
    ["Application protocols", 2, ["DNS", "HTTP/1.1", "HTTP/2", "HTTP/3", "WebSockets"], "apps"],
    ["Security", 3, ["TLS handshake", "Certificates and PKI", "VPNs"]],
    ["Network programming", 3, ["Sockets", "select, poll and epoll", "io_uring for networking", "Zero-copy"], "programming"],
    ["Infrastructure", 3, ["Load balancers", "CDNs", "Anycast"]],
  ]),

  track("distributed", "Distributed Systems", "Agreement among unreliable machines.", [
    ["Foundations", 1, ["Why distribute", "The network model: messages, delays and partitions", "Failure models", "The eight fallacies", "Timeouts, retries and idempotency", "Failure detectors"]],
    ["Time and order", 2, ["Physical clocks and drift", "NTP and clock synchronization", "Lamport clocks", "Vector clocks", "Hybrid logical clocks"], "time"],
    ["Replication", 2, ["Leader-follower", "Replication lag and read-your-writes", "Multi-leader", "Leaderless and quorums", "Anti-entropy and Merkle trees"]],
    ["Consistency", 3, ["Linearizability", "Sequential and causal consistency", "Eventual consistency", "Session guarantees", "CAP and PACELC", "Checking histories like Jepsen"]],
    ["Consensus", 3, ["The consensus problem", "FLP impossibility", "Paxos", "Multi-Paxos", "Raft leader election", "Raft log replication", "Raft membership changes and snapshots", "Byzantine fault tolerance"]],
    ["CRDTs", 3, ["State-based CRDTs", "Operation-based CRDTs", "Sets, maps and deletion", "Sequence CRDTs for collaborative editing"]],
    ["Partitioning", 2, ["Sharding", "Consistent hashing", "Rendezvous and jump hashing", "Rebalancing", "Secondary indexes across partitions", "Hot keys"]],
    ["Distributed transactions", 3, ["Two-phase commit", "Sagas", "Spanner and TrueTime", "Calvin and deterministic databases", "Percolator and snapshot isolation"], "transactions"],
    ["Coordination", 3, ["Leases and fencing tokens", "Distributed locks", "ZooKeeper and etcd"]],
    ["Data systems", 3, ["Gossip and SWIM", "Distributed logs", "Stream processing", "Exactly-once semantics"]],
    ["Building a replicated store", 4, ["Architecture of a replicated store", "A Raft key-value store, end to end", "Deterministic simulation testing", "etcd, CockroachDB and DynamoDB compared"], "capstone"],
  ]),

  track("graphics", "Computer Graphics & GPU", "Turning math into pixels.", [
    ["Foundations", 1, ["Pixels and color", "Color spaces and gamma", "2D transforms", "Homogeneous coordinates"]],
    ["Rasterization", 2, ["Lines and triangles", "Barycentric coordinates", "Depth buffering", "3D transforms and projection", "Clipping", "Writing a software rasterizer"]],
    ["Shading", 2, ["Lambert and Phong", "Normal mapping", "Physically based rendering", "Image-based lighting"]],
    ["Textures", 2, ["UV mapping", "Filtering and mipmaps", "Anti-aliasing"]],
    ["Ray tracing", 3, ["Ray-object intersection", "Recursive ray tracing", "BVH acceleration", "Path tracing", "Monte Carlo and importance sampling"], "ray-tracing"],
    ["Real-time techniques", 3, ["Shadow mapping", "Deferred shading", "Screen-space effects", "Global illumination approximations"], "realtime"],
    ["The GPU pipeline", 2, ["Vertex and fragment shaders", "WebGPU basics", "Compute shaders", "GPU memory and bandwidth"], "gpu"],
    ["Procedural graphics", 3, ["Noise functions", "Signed distance fields", "Ray marching"], "procedural"],
    ["Animation", 3, ["Keyframes and interpolation", "Quaternions", "Skinning", "Inverse kinematics for characters"]],
  ]),

  track("crypto", "Cryptography & Security", "Keeping secrets and breaking assumptions.", [
    ["Foundations", 1, ["Classical ciphers", "Kerckhoffs's principle", "Modular arithmetic", "Randomness and entropy"]],
    ["Symmetric cryptography", 2, ["One-time pad", "Stream ciphers", "Block ciphers and AES", "Modes of operation", "Authenticated encryption"], "symmetric"],
    ["Hashing and MACs", 2, ["Cryptographic hash functions", "Merkle trees", "HMAC", "Password hashing"], "hashing"],
    ["Public-key cryptography", 3, ["Diffie-Hellman", "RSA", "Elliptic curve cryptography", "Digital signatures", "Post-quantum cryptography"], "public-key"],
    ["Protocols", 3, ["TLS 1.3 in depth", "Signal protocol", "Zero-knowledge proofs"]],
    ["Software security", 3, ["Buffer overflows", "Return-oriented programming", "Mitigations: ASLR, canaries, CFI", "Memory-safe languages"], "software"],
    ["Side channels", 4, ["Timing attacks", "Cache attacks", "Spectre and Meltdown", "Constant-time code"]],
  ]),

  track("performance", "Performance Engineering", "Making code fast, with evidence.", [
    ["Measurement", 1, ["Benchmarking pitfalls", "Statistics of benchmarks", "Profilers", "Flame graphs", "Hardware performance counters"]],
    ["The memory hierarchy", 2, ["Latency numbers", "Cache-friendly code", "Data-oriented design", "Struct of arrays vs array of structs"], "memory"],
    ["CPU-level optimization", 3, ["Branch prediction and branchless code", "SIMD by hand", "Auto-vectorization", "Instruction-level parallelism"], "cpu"],
    ["Concurrency performance", 3, ["False sharing", "Contention", "Lock-free vs locked in practice"], "concurrency"],
    ["Systems performance", 3, ["I/O performance", "Latency vs throughput", "Tail latency", "Queueing theory and Little's law"], "systems"],
  ]),
];

// ---------- lookups ----------
export function allLessons(): (Lesson & { track: Track; module: Module })[] {
  return TRACKS.flatMap((t) => t.modules.flatMap((m) => m.lessons.map((l) => ({ ...l, track: t, module: m }))));
}

export function findTrack(slug: string): Track | undefined {
  return TRACKS.find((t) => t.slug === slug);
}

export function findLesson(trackSlug: string, moduleSlug: string, lessonSlug: string) {
  const track = findTrack(trackSlug);
  const module = track?.modules.find((m) => m.slug === moduleSlug);
  const lesson = module?.lessons.find((l) => l.slug === lessonSlug);
  if (!track || !module || !lesson) return undefined;
  return { track, module, lesson };
}

/** Previous/next lesson within the track, in curriculum order. */
export function neighbors(path: string) {
  const [trackSlug] = path.split("/");
  const list = allLessons().filter((l) => l.track.slug === trackSlug);
  const i = list.findIndex((l) => l.path === path);
  return { prev: i > 0 ? list[i - 1] : undefined, next: i >= 0 ? list[i + 1] : undefined };
}
