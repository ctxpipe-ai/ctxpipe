# Plan: Kubernetes / large-repo CGC indexing OOM

**Status:** Draft for refinement (no implementation yet)  
**Context:** Railway `pr-253` postmortem — single Kubernetes `cgc index` pins codesearch at 24 GB, exit 137; Zoekt starved; OpenWorkflow retries amplify. Smaller repos (e.g. `TRURecognition/trurec-evaluator`) succeed once credits/runtime are healthy.  
**Constraint from product:** Fix the **root cause** (peak memory of one index job). Do **not** “fix” this by splitting services, downgrading CGC, or treating async/status/retry polish as the main solution.

---

## 1. Why we keep patching (architecture diagnosis)

The ingest pipeline treats CodeGraphContext as a black box:

```
POST /index  →  clone/checkout  →  zoekt-index  →  cgc index . [--force]  →  200
```

[#253](https://github.com/ctxpipe-ai/ctxpipe/pull/253) correctly removed stacked `cgc watch` processes, serialized concurrent `/index` runs, bounded child log buffers, and stopped holding org DB transactions across the long HTTP call. Those were real bugs. They did **not** change the fact that **one** full CGC pass still materializes the whole checkout’s parse results in RAM.

So each incident looked different (watchers → idle-tx → fetch failed → exit 137) while the underlying assumption stayed the same: “`cgc index .` on the entire tree is viable for any repo size inside the shared codesearch memory envelope.”

**Principle going forward:** Memory of a single graph-index job is a first-class product constraint. We optimize or redesign *how* that job builds the graph—not how many jobs we run in parallel, and not how we report failure after OOM.

---

## 2. Root cause (current best model)

### 2.1 What fails

| Observation | Implication |
|-------------|-------------|
| Memory climbs ~5→24 GB on one Kubernetes index | Peak is dominated by **one** CGC process, not cross-repo concurrency |
| Exit **137** + Kùzu schema stderr | OOM kill; schema errors may be a separate correctness issue under pressure / version skew |
| Zoekt `/healthz` timeouts during the same window | Shared container envelope; CGC starves query path (symptom, not root) |
| `all_file_data` called out in #253 as unfixed | Upstream CLI retains parsed file payloads for the global linking pass |

### 2.2 How CGC CLI uses memory (upstream `pipeline.py`, current main)

1. Discover all indexable files under the checkout (`.cgcignore` + defaults).
2. Parse with a hard-coded `asyncio.Semaphore(10)`.
3. Append every successful parse into **`all_file_data: list`**.
4. Sort that list, write nodes, then build CALLS / INHERITS / … over the **entire** list.
5. On the **index** path, that list is **not** cleared after linking (watcher-path clears exist in older OOM PRs; full index still holds the corpus through the heavy phases).

Peak RSS therefore scales roughly with **#files × symbols/AST payload retained**, plus Kùzu write buffers—before Zoekt’s own footprint in the same container.

### 2.3 Why the browser/WASM path feels fine (and what to verify)

CGC’s site (`website/` Explore + `parser.worker.ts`) is a **different indexer**:

- Tree-sitter **WASM** in a worker; files sent in **chunks** (e.g. 50).
- Aggressive path ignores (`vendor`, `test`/`tests`, `node_modules`, …).
- Source-extension filter (no “index every file type the CLI might touch”).
- Soft caps (`maxNodes` / `maxEdges`, e.g. 100k / 50k defaults in Explore).
- Famous repos (including **kubernetes**) can also be loaded via **pre-built `.cgc` bundles** (instant, no re-parse).

**Open verification before we copy “browser” blindly:** confirm whether the demo Tom saw was (a) full zip+WASM parse of kubernetes, (b) capped sample, or (c) bundle load. Regardless, the browser path proves the *algorithmic* point we care about: **streaming / chunking / ignore / caps** keep peak memory bounded; our server path does the opposite (retain whole corpus, `--force` full rebuild).

### 2.4 What is *not* the root cause

| Item | Role |
|------|------|
| Separate indexing service | Rejected — more services, shared filesystem complexity, doesn’t shrink one job’s RSS |
| Async `/index` alone | Improves resiliency / false `fetch failed`; **same CGC still OOMs** |
| Retry dedupe alone | Mostly already present; retries can **worsen** OOM by replaying full `--force` |
| Lifecycle flags (zoekt vs graph) | Correctness polish after CGC fails mid-flight |
| Pinning older CGC | Forbidden — later CGC has OOM-oriented fixes; stay on **latest** (floor pin OK, never downgrade) |

---

## 3. Goal

**Kubernetes (and similar monorepos) complete graph indexing inside the existing codesearch memory budget** (today ~24 GB on Railway preview; ECS profiles are much smaller) **without** colocating a second indexing service, and **without** depending on raising the limit as the fix.

Success criteria (propose for refinement):

1. One full index of `kubernetes/kubernetes` at a pinned commit finishes with CGC exit 0 under a **memory ceiling we choose** (e.g. ≤12 GB RSS for `cgc`, or ≤ container limit with headroom for Zoekt).
2. Peak RSS during that run is **measured** and **stable** across rebuilds (latest CGC + compatible Kùzu).
3. Schema/parser failures (`DbColumn` / `RedisKeyPattern`) are either fixed or classified **non-retryable**—not masked by OW/HTTP retries.
4. Zoekt remains responsive enough for `/healthz` during index (secondary; expected if CGC peak drops).

---

## 4. P0 — Fix peak memory of one CGC job

Work is ordered as **hypothesis → measure → change**. Supporting reproduction stays **local/CI ephemeral**—do not commit large kubernetes fixtures or long-running repro harnesses into the repo.

### 4.0 Supporting reproduction (not a deliverable artifact)

- Rebuild codesearch image with **latest** `codegraphcontext` (already unpinned in Dockerfile) and record installed versions (`cgc version`, `pip show kuzu`).
- Index a fixed kubernetes commit under a cgroup/Docker memory limit; sample RSS for clone / zoekt / cgc phases; capture file counts CGC discovers vs ignores.
- Diff that file set against browser ignore rules + extension filter.
- Confirm whether website “fast kubernetes” was bundle vs full WASM parse.

Use results to pick among 4.1–4.3; do not land the repro itself.

### 4.1 Align discovery with the memory-bounded indexer (likely first win)

**Hypothesis:** CLI discovers far more paths than the WASM explorer (tests, vendor-like trees, generated noise, extra languages/extensions), so `all_file_data` is huge before linking even starts.

**Actions:**

- Before `cgc index`, ensure an effective ignore set equivalent to (or stricter than) the browser `IGNORED_DIRS` / Explore filters—via injected `.cgcignore` in the checkout, `CGCIGNORE`-style path if available, or codesearch-owned ignore file passed explicitly.
- Prefer **source-code graph** over indexing every file type the CLI can parse; exclude high-churn / low-signal trees typical of Go monorepos (`vendor/`, `third_party/`, `testdata/`, generated `*.pb.go` if product-acceptable, `_output/`, etc.)—tune with product, not blindly.
- Re-measure file count and peak RSS. If RSS drops under budget, this may be enough for kubernetes **without** replacing the CLI.

**Risk:** Over-ignoring reduces graph usefulness. Mitigate with a documented default ignore policy + optional org/repo overrides later (out of scope for first cut unless needed).

### 4.2 Stop retaining the whole corpus (match browser algorithm)

**Hypothesis:** Even with better ignores, kubernetes’s remaining Go corpus still blows `all_file_data` because the CLI holds every parse until global linking finishes.

**Preferred directions (pick after 4.0/4.1 measurements):**

1. **Drive CGC in bounded waves (still one service, same Kùzu file)**  
   - Index subdirectory / package shards with incremental `cgc index <path>` (no `--force` after the first seed), so each process (or each wave) only retains a slice of `all_file_data`.  
   - Validate that incremental merges produce correct cross-package CALLS (this is the hard part—may require a final linking strategy or upstream support).  
   - Avoid double `--force` full rebuilds on every tip when a usable Kùzu DB already exists (today **full** ingest always uses `--force`).

2. **Upstream / stay on latest CGC with streaming semantics**  
   - Prefer contributing or adopting upstream changes that clear or stream `all_file_data` after per-file write / after linking, and expose concurrency / working-set knobs.  
   - **Do not downgrade.** Optionally pin a **minimum** version once a release includes the needed memory behavior; keep Kùzu on a compatible recent line (slight pin/shift OK).

3. **Server-side WASM / worker-style indexer (only if CLI cannot bound memory)**  
   - Port the Explore worker approach into codesearch (Bun/Node worker or subprocess): chunked tree-sitter parse → nodes/edges → load into the per-checkout Kùzu DB (or `cgc bundle` import path).  
   - Same process/service, same files on disk—**not** a new microservice.  
   - Highest engineering cost; strongest alignment with “browser can do kubernetes.”

**Explicit non-goal:** Running Zoekt and CGC in separate containers/services.

### 4.3 Kùzu + CGC compatibility (correctness, may interact with OOM)

- Keep CGC at **latest**; adjust `kuzu` only as needed for schema compatibility with that CGC.
- Reproduce `DbColumn` / `RedisKeyPattern` `CREATE NODE TABLE` parser errors on a small fixture that triggers those node types.
- Treat schema/parser failures as **terminal** for that index attempt (no OW “maybe transient” replay). OOM (137) vs schema errors should be distinguished in codesearch error surfaces so retries don’t thrash.

### 4.4 Version policy

| Package | Policy |
|---------|--------|
| `codegraphcontext` | Latest at image build (current Dockerfile). Never pin to older than what we already run. Optional **minimum** pin after a known-good memory fix. |
| `kuzu` | Compatible with that CGC; slight pin OK; no downgrade of CGC to please Kùzu. |
| Zoekt | Unrelated to CGC RSS; pinning `@latest` can stay a separate hygiene task—optional. |

---

## 5. Optional resiliency (explicitly not root-cause fixes)

Mark these as **follow-ups** after (or in parallel with, if cheap) P0 memory work. They improve operability; they do not make kubernetes fit in RAM.

### 5.1 Async `/index` — optional

- **Problem it solves:** Long synchronous HTTP → gateway/`fetch failed` while CGC is still alive or wedged; OW interprets network blips as reindex fuel.
- **Shared DB:** Backend, OpenWorkflow (`openworkflow` schema), and codesearch already share **one Postgres**. Codesearch already writes `repository_checkouts`.
- **Avoid new tables if possible:** Prefer updating existing product fields (`repositories.indexingStatus` / error / checkout sha) rather than teaching codesearch to mutate OpenWorkflow step rows (couples codesearch to OW internals and migrations).
- **OW ownership:** Keep durable step orchestration in the worker; codesearch remains “do the work + report terminal status on shared repo/checkout rows.” If async, `/index` enqueues in-process work (still `MAX_CONCURRENT_INDEX_RUNS = 1`) and returns a job id **or** the worker polls checkout/repo status—design detail for refinement.
- **Does not replace P0.**

### 5.2 Deduplicate / bound retries — optional (mostly done)

Already in place:

- Per-repo `tryClaimRepositoryIndexingEnqueue` single-flight (+ stale reclaim).
- Success-only tip follow-up; **no** auto-chain on failure.
- `reindexStep` `maximumAttempts: 2`.
- Transient HTTP retries only for network/502–504—not for CGC 500/OOM.

Optional polish: never retry on classified OOM/schema errors; coalesce duplicate `/index` while one wave is running. Still not the memory fix.

### 5.3 Lifecycle state ordering — optional

Today Zoekt success updates `repository_checkouts.commitSha` **before** CGC. If CGC dies, search tip and graph DB can disagree.

Optional: split `zoektIndexed` vs `graphIndexed` (or only advance commitSha after CGC succeeds). Correctness/UX; not RSS.

### 5.4 Reproduction harness — supporting only

Keep ephemeral; do not commit kubernetes trees or mandatory multi-GB CI jobs.

---

## 6. Suggested implementation sequence (for refinement)

```text
Phase 0  Measure (ephemeral): latest CGC+kuzu, kubernetes file counts, RSS stairs, website=bundle?
Phase 1  Discovery parity: ignores + extension policy; re-benchmark kubernetes
Phase 2  If still over budget: bounded waves / stop blanket --force / upstream streaming
Phase 3  If still over budget: WASM/chunked indexer in codesearch writing same Kùzu
Phase 4  Schema error classification + kuzu compat
Phase 5  (Optional) async status + retry/lifecycle polish
```

Gate each phase on **measured peak RSS**, not on “retries look healthier.”

---

## 7. Out of scope / rejected

- New codesearch-vs-indexer split service or job runner fleet.
- Raising Railway/ECS memory as the primary fix (may be a temporary ops lever only).
- Downgrading `codegraphcontext` to dodge Kùzu errors.
- Committing kubernetes reproduction datasets.
- Replacing FalkorDB org knowledge graph (ADR-010) — unrelated; per-repo code graphs stay on CGC/Kùzu as today unless a later ADR says otherwise.

---

## 8. Key code pointers

| Area | Location |
|------|----------|
| `/index` + CGC spawn | `apps/codesearch/src/domain/indexing/service.ts` |
| full vs partial args (`--force`) | `apps/codesearch/src/domain/indexing/cgcIndex.ts` |
| concurrency = 1 | `apps/codesearch/src/domain/indexing/indexConcurrency.ts` |
| Dockerfile CGC/kuzu install | `apps/codesearch/Dockerfile` |
| Graph query (Kùzu) | `apps/codesearch/src/domain/graph/executeGraphPrimitive.ts` |
| Reindex HTTP + transient retries | `apps/backend/src/graphs/codeIngestionGraph/nodes/reindex.ts` |
| OW reindex attempts | `apps/backend/src/openworkflow/workflows/repository-ingestion.ts` |
| Queue / single-flight | `apps/backend/docs/repository-ingestion-queue.md` |

---

## 9. Open questions for refinement

1. Product tolerance: which paths may we ignore by default on huge Go repos without harming MCP graph answers?
2. Was the website kubernetes demo a **bundle**, a **capped** WASM parse, or a **full** parse? (Changes weight of 4.1 vs 4.2.3.)
3. Target memory ceiling for codesearch in prod/preview (hard number for Phase gates).
4. Is incremental multi-path `cgc index` semantically safe for cross-file CALLS on kubernetes, or must we invest in upstream streaming / WASM load?
5. Optional async: is updating `repositories` / `repository_checkouts` enough for UX, or do we need OW step visibility beyond today’s workflow logs?
