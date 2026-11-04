/**
 * Query-processing sims (Databases track, module "query"). Pure TypeScript, deterministic, no React.
 *
 * - relation: values, rows, schemas, bag equality, the sample tables emp/dept/proj and `scaledDb`.
 * - expr:     predicates with SQL three-valued logic; `compilePred`, `conjuncts`, text forms.
 * - algebra:  plan trees, a bag-semantics evaluator that keeps every intermediate result, SQL block →
 *             canonical algebra, and equivalence rules (cascade, selection and projection pushdown,
 *             selections to joins, join associativity) with `rewriteSteps`.
 * - iterator: Volcano operators (Scan, Filter, Project, NestedLoopJoin, HashJoin, Sort, Limit, HashAgg)
 *             with call counters, a trace, memory held, `fromPlan` and `pipelines`.
 * - joins:    paged relations and seven join algorithms with page I/O accounting, plus cost formulas.
 * - extsort:  external merge sort with frames, pass formulas, replacement selection, hash and sort
 *             aggregation (with spilling) and top-N with a heap.
 * - vector:   columnar batches with selection vectors, branch-free primitives, a vector-size cost model
 *             and a branch-predictor simulation.
 * - codegen:  produce/consume code generation and a compile-versus-interpret time model.
 */
export * from "./relation";
export * from "./expr";
export * from "./algebra";
export * from "./iterator";
export * from "./joins";
export * from "./extsort";
export * from "./vector";
export * from "./codegen";
