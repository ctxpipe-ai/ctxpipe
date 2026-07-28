# Plan: Kubernetes / large-repo CGC indexing OOM

**Status:** Verified draft (ephemeral measurements done; **no product fix implemented**)  
**Branch:** `cursor/cgc-k8s-oom-plan-5b38`  
**Context:** Railway `pr-253` postmortem — one Kubernetes `cgc index` pins codesearch at 24 GB (exit 137).  
**Product constraints:** Fix peak memory of **one** job; stay on **latest** CGC (no downgrade); do **not** split indexing into a new service; do **as little work as necessary** (no requirement to use `--force`); async/retry/lifecycle are optional resiliency only.

Ephemeral evidence lives under `/tmp/cgc-oom-verify/` on the agent VM (not committed). Summary snapshot: `/tmp/cgc-oom-verify/results/SUMMARY.md`.

---

## 0. Executive verdict (after verification)

| Question | Answer |
|----------|--------|
| Was the website kubernetes demo a prebuilt bundle? | **No.** Explore does live WASM parse with progress (“Initializing WebAssembly…”, “Indexing: …”). Kubernetes is **not** in the public `.cgc` registry. |
| Is the browser/WASM indexer viable as our server graph builder? | **No** as a drop-in. Different schema, weak CALLS, hard caps (100k nodes / 50k CALLS), no `KUZUDB_PATH` write. Useful as **inspiration** for chunking/ignores only. |
| Do we need `--force`? | **Not for first index.** Plain `cgc index .` builds an empty DB. **`--force` is only required today because plain re-index SKIPPS when the repo is already indexed** — our “partial” path is therefore a **no-op** after first success. |
| Why does one job OOM? | (1) CGC discovers **~31k** files on kubernetes vs browser’s **~12k**; (2) CLI retains full `all_file_data` for linking; (3) real Go is extremely heavy — **`pkg/controller` alone hit ~11.7 GB RSS** mid-run on CGC 0.5.3. |

**Primary fix direction:** stop treating `cgc index . [--force]` as the only graph mutation API. Use **path-scoped GraphBuilder updates** for tip advances, **aggressive discovery policy** for first builds, and only full rebuild when necessary — then attack remaining peak RSS of first full builds (streaming / upstream) until kubernetes fits the envelope.

---

## 1. Why we keep patching (architecture)

```
POST /index → clone/checkout → zoekt-index → cgc index . [--force] → 200
```

[#253](https://github.com/ctxpipe-ai/ctxpipe/pull/253) fixed watchers, idle-tx, log tails, and serialize-to-1. It did **not** change discovery breadth, CLI skip semantics, or `all_file_data` retention.

**Principle:** Memory of one graph-index job is a first-class constraint. Prefer less work and smaller working sets over more services or larger RAM.

---

## 2. Verified findings

### 2.1 Browser / WASM (Explore SPA)

Live host: `https://codegraphcontext.vercel.app/kubernetes/kubernetes` (not the MkDocs docs site).

**Flow:** ZIP download → unzip in RAM → filter source extensions → `web-tree-sitter` worker → in-memory `{nodes, links}` → IndexedDB cache. Progress UI matches Tom’s observation.

| Property | Explore WASM | Our codesearch CLI path |
|----------|--------------|-------------------------|
| Persistence | In-memory / optional `.cgc` JSON export | Per-checkout **Kùzu** via `KUZUDB_PATH` |
| CALLS | Name-heuristic, capped **50k** | Full multi-tier resolver (`resolution/calls.py`) |
| Caps | `maxNodes=100k`, `maxEdges=50k` | Unbounded (until OOM) |
| Ignores | `vendor`, `test(s)`, etc. | Default `.cgcignore` ≈ node_modules/venv/media only |
| File set (k8s) | ~**11.7k** source after ignores | **31,223** discovered (go+yaml+json+vendor+testdata+…) |

**Viability for Bun codesearch:** MIT-licensed and technically portable, but **wrong product graph**. Reusing it would break MCP/graph query parity. **Do not** replace `cgc`/Kùzu with the website worker. Optionally borrow ignore lists and “don’t retain whole-ZIP forever” lessons.

### 2.2 `--force` and “incremental” today (our code + CGC 0.5.3)

Our mapping (`cgcIndex.ts`):

| `ingestMode` | Command | Reality vs CGC 0.5.3 |
|--------------|---------|----------------------|
| `full` (no `fromHash`, or non-ancestor) | `cgc index . --force` | Wipe Repository + rebuild |
| `partial` (ancestor `fromHash`) | `cgc index .` | **If DB already has files → SKIP exit 0** — graph **not** updated |

Ephemeral proof (tiny Go repo):

1. First `cgc index .` → success (2 funcs, 1 CALL), ~353 MB RSS.  
2. Second `cgc index .` → `already indexed with 2 files. Skipping.`  
3. Edit file + `cgc index .` → **still Skipping** (stale graph).  
4. `cgc index . --force` → picks up new symbols.

Backend always sends `fromHash: lastIngestedHash` on tip advance → codesearch chooses `partial` → **silent stale Kùzu** while LLM ingest may still use git diffs. Comments claiming “merge into existing KUZUDB_PATH” are **wrong** for current CGC.

Upstream true incremental surface is **Python `GraphBuilder`** (`update_file_in_graph` / `delete_file_from_graph` + neighbor relink), or `cgc watch --sync-on-start` (re-parses **all** files; blocks; not one-shot CLI). Subdir `cgc index ./pkg` creates a **different** Repository node — does not update the root index.

### 2.3 Discovery gap (kubernetes @ `5f912517…`, shallow clone)

| Filter | Files |
|--------|------:|
| CGC `discover_files_to_index` (default) | **31,223** |
| … `.go` | 17,846 |
| … under `testdata/` | 9,771 |
| … under `vendor/` | 5,555 |
| … `*_test.go` | 3,448 |
| Browser SOURCE + `IGNORED_DIRS` | **11,678** |
| Browserish `.cgcignore` (vendor/testdata/yaml/json/md/`*_test.go`/…) | **10,950** (~9,880 `.go`) |

Default auto-`.cgcignore` does **not** exclude vendor/testdata/yaml.

### 2.4 Memory measurements (CGC **0.5.3**, kuzu **0.11.3**, 15 GiB host)

**Synthetic** simple Go files (~5 lines): ~350 MB base + ~0.55 MB/file (50→2000 files: 407→1461 MB).

**Real** `kubernetes/pkg/util` (~69 scanned files):

| Env | Time | max RSS | CALLS |
|-----|------|--------:|------:|
| default | ~42 s | **~1.19 GB** | 1860 |
| `INDEX_SOURCE=false` | ~113 s | ~1.23 GB | 1860 |
| + `SKIP_EXTERNAL_RESOLUTION=true` | ~97 s | **~0.95 GB** | 367 |

`INDEX_SOURCE=false` did **not** help RSS. `SKIP_EXTERNAL_RESOLUTION` trims CALLS/RSS modestly (product trade-off).

**Real** `kubernetes/pkg/controller` (~619 discovered): `cgc index . --force` reached **VmHWM ≈ 11.7 GB** after ~10 min with no completion summary yet (killed to free the VM). Full-tree kubernetes at 24 GB is consistent with this.

### 2.5 Schema warnings (latest stack)

Every Kùzu open logs parser errors for composite PKs on `DbColumn` / `RedisKeyPattern` (kuzu 0.11.3). Non-fatal for plain Go indexing; still a correctness/hygiene issue — shift kuzu or fix DDL with **latest** CGC, never downgrade CGC.

### 2.6 GraphBuilder path (smoke)

`get_database_manager(db_path=…)` + `GraphBuilder(db, JobManager(), loop)` + `update_file_in_graph` / `delete_file_from_graph` runs without crashing. **Repository path matching is finicky** (saw `Repository node not found` when paths didn’t match how `cgc index` registered the repo). Implementation must use the **same absolute repo path** CGC stored and mirror watcher neighbor-relink. Treat as a **failing integration test** until green.

---

## 3. Root-cause model (refined)

Three stacked causes:

1. **Too much work per tip** — `--force` full rebuild (or broken skip) instead of path-scoped updates using existing `changedPaths`/`deletedPaths`.  
2. **Too many files on first build** — default discovery indexes yaml/json/vendor/testdata/tests.  
3. **Unbounded working set** — `all_file_data` holds the whole parse corpus for linking; real Go ASTs are huge (~tens of MB/file effective peak vs toy synth).

Browser feels fine because it **indexes fewer files**, **caps the graph**, and **doesn’t build CLI-quality CALLS into Kùzu** — not because WASM magically compresses the same algorithm.

---

## 4. Goal / success criteria

1. Tip advance on an already-indexed checkout updates Kùzu for **changed/deleted paths only** (no whole-tree `--force` unless classified rebuild).  
2. First index of kubernetes at a pinned commit completes under an agreed ceiling (propose **≤12 GB CGC RSS** with headroom for Zoekt in the same 24 GB envelope — refine with ops).  
3. Schema/parser failures and OOM are **terminal / non-retryable** classifications.  
4. Automated tests encode (1)–(3) and fail on `main` until fixed (**TDD**).

---

## 5. TDD plan (write tests first; no production fix in this PR)

All new tests should fail (or xfail→fail) against current behavior, then drive the fix.

### 5.1 Unit — codesearch CGC strategy

| Test | Current expected failure |
|------|---------------------------|
| `cgcIndexArgsForIngestMode('full')` must **not** unconditionally append `--force` when DB empty / first index | Today always `--force` for full |
| Tip-advance strategy selects **path update** API, not `cgc index .` | Today selects skip-prone CLI |
| `--force` only when `needsFullRebuild` (missing DB, corrupt, non-ancestor, explicit purge) | Today tied to ingestMode |

Files: `apps/codesearch/src/domain/indexing/cgcIndex.test.ts` (+ new helper module tests).

### 5.2 Integration — Python helper (codesearch image / vitest+spawn)

Use tiny fixtures under `apps/codesearch` test temp dirs (not kubernetes in git):

| Test | Assert |
|------|--------|
| First `index` without `--force` creates Kùzu + symbols | already true upstream; lock it |
| Edit one file + **our** update path → new function appears; deleted file’s symbols gone | **fails today** with plain `cgc index .` |
| Second plain `cgc index .` after edit still skips (document upstream); our wrapper must not rely on it | characterization |
| Aggressive ignore fixture: yaml/vendor/testdata not in scanned count | fails until we inject ignore policy |
| Peak RSS of N-file fixture under cgroup/soft limit (optional, marked heavy) | gate for regressions |

Prefer a small `scripts/cgc_index_update.py` (mirroring `cgc_graph_query.py`) tested via spawn — keeps Bun ↔ Python boundary explicit.

### 5.3 Backend characterization

| Test | Assert |
|------|--------|
| Partial reindex with `fromHash` still requires graph mutation when tip moves | documents today’s stale-graph hole if codesearch returns 200 on skip |

### 5.4 Ephemeral kubernetes gate (not committed; CI optional nightly)

Script outline (already prototyped under `/tmp/cgc-oom-verify`):

1. Shallow clone pinned kubernetes SHA.  
2. Measure discover counts default vs policy.  
3. Run first-index with policy; sample `VmHWM`.  
4. Mutate/checkout tip; run path-update; assert duration ≪ full rebuild and RSS ≪ first index.  

Do **not** commit the kubernetes tree. Optional: nightly job with memory limit.

---

## 6. Implementation plan (after tests exist)

### P0-A — Minimal-work tip advance (correctness + stops repeat OOM)

1. Add codesearch Python helper using `get_database_manager` + `GraphBuilder`:  
   - `delete_file_from_graph` for `deletedPaths`  
   - `update_file_in_graph` for `changedPaths`  
   - neighbor CALLS/INHERITS relink (copy watcher recipe)  
2. Wire `runCgcIndex`:  
   - **Empty / missing Kùzu:** `cgc index .` (**no** `--force`)  
   - **Partial tip with diffs:** helper above  
   - **`--force` / wipe:** only `needsFullRebuild`  
3. Fix Repository absolute-path registration so updates attach to the same node `cgc index` created.  
4. Green the integration tests in §5.2.

### P0-B — Shrink first-index discovery

1. Codesearch-owned ignore policy (injected `.cgcignore` or explicit path), aligned with Explore + Go monorepo noise: `vendor/`, `testdata/`, `third_party/`, `*_test.go`, non-source (yaml/json/md) unless product needs them.  
2. Unit test scanned-file counts on a fixture.  
3. Re-run ephemeral kubernetes discover + RSS; record new peak.

### P0-C — Bound peak RSS of remaining full builds

If kubernetes still exceeds ceiling after A+B:

1. Prefer **upstream** CGC streaming / clearing `all_file_data` / configurable concurrency (stay on latest; optional minimum pin once fixed).  
2. And/or **wave indexing** that never retains the full corpus (validate CALLS quality).  
3. Evaluate `SKIP_EXTERNAL_RESOLUTION=true` as an explicit product knob (measured ~20% RSS cut on `pkg/util`; reduces CALLS).  
4. **Not** porting Explore WASM as the Kùzu writer.

### P0-D — Kùzu schema hygiene

Reproduce `DbColumn`/`RedisKeyPattern` on a tiny fixture; fix via compatible **recent** kuzu or upstream DDL; classify as non-retryable if fatal.

### Optional resiliency (not root cause)

- Async `/index` / status on existing `repositories` + `repository_checkouts` (same Postgres; don’t teach codesearch OW step tables).  
- Don’t retry OOM/schema; single-flight already mostly done.  
- Advance checkout `commitSha` only after graph success (or split zoekt vs graph flags).

### Rejected

- Separate indexing microservice.  
- Downgrading CGC.  
- Raising RAM as the primary fix.  
- Replacing CLI/Kùzu with website WASM for MCP graphs.  
- Committing kubernetes fixtures.

---

## 7. Suggested build sequence

```text
1. Land failing tests (§5)                          ← this unlocks TDD
2. P0-A path-scoped updates + stop blanket --force
3. P0-B discovery/ignore policy
4. Ephemeral kubernetes re-measure
5. P0-C only if still over ceiling
6. P0-D schema
7. Optional resiliency
```

Gate merges on tests, not on “retries look healthier.”

---

## 8. Open questions for refinement

1. **Ignore policy:** OK to drop yaml/json/testdata/vendor/`*_test.go` from the **code** graph by default?  
2. **RSS ceiling:** Is ≤12 GB CGC / 24 GB container the right gate?  
3. **CALLS trade-off:** Accept `SKIP_EXTERNAL_RESOLUTION` for Go monorepos?  
4. **First kubernetes index:** If A+B still OOMs, prioritize upstream CGC patch vs in-house wave indexer?  
5. **Partial LLM vs graph:** Keep git `changedPaths` for LLM even when graph uses GraphBuilder (yes — already separated).

---

## 9. Key code pointers

| Area | Location |
|------|----------|
| Mode → `--force` | `apps/codesearch/src/domain/indexing/cgcIndex.ts` |
| Spawn + env | `apps/codesearch/src/domain/indexing/service.ts` |
| Diff paths for LLM | same `service.ts` (`changedPaths` / `deletedPaths`) |
| Graph query helper pattern | `apps/codesearch/scripts/cgc_graph_query.py` |
| Backend `fromHash` | `apps/backend/src/openworkflow/workflows/repository-ingestion.ts` |
| Dockerfile CGC install | `apps/codesearch/Dockerfile` |

---

## 10. Appendix — ephemeral commands (reproduce locally)

```bash
python3 -m venv /tmp/cgc-oom-verify/.venv
source /tmp/cgc-oom-verify/.venv/bin/activate
pip install codegraphcontext kuzu
git clone --depth 1 https://github.com/kubernetes/kubernetes.git /tmp/cgc-oom-verify/kubernetes
# discovery counts, tiny skip/--force proof, pkg/util RSS, etc.
# see /tmp/cgc-oom-verify/results/SUMMARY.md from the agent run
```

Versions measured: **codegraphcontext 0.5.3**, **kuzu 0.11.3**.
