# ADR-027: Size-based OpenWorkflow concurrency for single-instance codesearch

**Status:** Accepted | **Date:** 2026-08-28 | **Tags:** codesearch, openworkflow, ingestion, capacity

## Context

Codesearch cannot be horizontally scaled. Zoekt shards, git clone cache, and SCIP artifacts live on one process and one volume (Railway volume / CDK EFS). CDK already keeps `codesearchDesiredCount: 1` on every size; Railway Terraform pins `num_replicas: 1`.

OpenWorkflow only exposes process-wide `worker.concurrency` (config or `--concurrency`), read at worker start. There is no per-workflow concurrency API. Nested `step.runWorkflow` parents park via `SleepSignal` and do **not** multiply worker slots: during index, one ingest occupies one slot (`repository-index`). After index returns, extract runs in `repository-ingestion` (one slot). SCIP languages still fan out with `Promise.all` inside that child run.

A hardcoded `worker.concurrency: 20`, times CDK `large`’s two workers, allowed 40 concurrent runs against one codesearch. Clone/checkout was not covered by the indexer spawn semaphore. Twenty concurrent clones of large repos OOM a 4–12 GiB task before SCIP starts. Kubernetes ingest peaks around 5.2 GiB for one repo; CDK `small` is 4 GiB.

Railway has no Fargate-style committed memory in IaC (usage-billed). Capacity must be injected at deploy time from a shared table, not probed at worker start.

## Decision

1. **Codesearch stays one replica** on Railway, CDK, and Compose. Do not raise codesearch desired count to absorb ingest queue pressure.

2. **Codesearch memory is the capacity signal.** A shared table in [`apps/backend/src/openworkflow/codesearchCapacity.ts`](../../../apps/backend/src/openworkflow/codesearchCapacity.ts) maps size → indexer spawn slots, in-flight index pipelines, and cluster OpenWorkflow budget. CDK `SIZE_PROFILES` mirrors the same tuples. Extra RAM is headroom per job, not extra parallel SCIP: indexer children pin `GOMAXPROCS=2`, and CDK `large` codesearch is still 2 vCPU.

   | Size | Memory | Indexer spawn | Index pipelines | Cluster OW budget | Per-worker concurrency |
   |------|--------|---------------|-----------------|-------------------|------------------------|
   | small | 4 GiB | 1 | 1 | 6 | 6 (1 worker) |
   | medium | 8 GiB | 2 | 2 | 10 | 10 (1 worker) |
   | large | 12 GiB | 2 | 2 | 16 | 8 (2 workers) |

   `OPENWORKFLOW_CONCURRENCY = max(2, floor(clusterWorkflowBudget / workerReplicas))`. Unset/invalid defaults to **4** (safer for local Compose and forgotten Railway vars), clamped 2..64.

3. **Worker replicas do not multiply ingest.** CDK `large` keeps `workerDesiredCount: 2` so extract/connectors can use extra CPU. Injected per-worker concurrency divides the cluster budget. Raising worker count without growing codesearch memory (and the injected env) must not raise clone/SCIP parallelism.

4. **Deploy-time env, not runtime probe:**
   - Worker: `OPENWORKFLOW_CONCURRENCY`, `CODESEARCH_INDEXER_CONCURRENCY` (SCIP HTTP batch size).
   - Codesearch: `CODESEARCH_INDEXER_CONCURRENCY` (spawn semaphore), `CODESEARCH_INDEX_PIPELINE_CONCURRENCY` (distinct repos with in-flight OW phase HTTP, clone included).
   - Pipeline overflow returns **429 + Retry-After**. `repository-index` sleeps and retries with a new step name so OpenWorkflow memoization does not stick a failure. Durability stays in OW steps; memory admission stays in-process on codesearch (no cross-step Postgres lease table).

5. **Hosted Railway:** production starts at the **medium** pair (indexer 2, pipelines 2, worker concurrency 10), chosen from observed ingest peak RSS — not a Terraform “plan size” (Railway services have no CPU/memory fields). PR preview uses the **small** pair. Changing these variables requires redeploying worker and codesearch.

6. **Compose `deploy`:** small defaults. Host `pnpm dev` keeps the unset default of 4.

## Consequences

- Operators pick CDK `size` or Railway Terraform defaults; they do not set concurrency by hand unless they later need an escape hatch.
- `sync-github-repositories` can still enqueue every new repo at once. Pending runs sit in the `openworkflow` Postgres schema; the pipeline cap must absorb that stampede, not OW slot count alone.
- Self-host docs must state that scaling workers does not scale ingest unless codesearch memory and injected env grow with them.
- CDK, Railway, and Compose must stay aligned with the table above; `size-profiles.test.ts` asserts CDK injection.

## Alternatives considered

- **Runtime memory probe in the worker** — Rejected; OpenWorkflow concurrency is process-start, and Railway has no committed task memory to read.
- **Horizontal codesearch replicas** — Rejected; shards and clone cache are single-volume, single-process. A second replica splits Zoekt hot pins and bypasses in-process admission.
- **Per-workflow concurrency API** — OpenWorkflow does not expose one. Process-wide concurrency plus codesearch admission is the thinnest control.
- **Postgres lease table for index pipelines** — Rejected; admission stays at the codesearch process boundary (existing lesson: durability in OW steps, memory at spawn/HTTP).
