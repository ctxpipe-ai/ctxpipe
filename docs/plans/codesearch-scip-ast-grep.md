# Plan: Reliable codesearch structural intelligence (post-CGC OOM)

**Status:** Strategic draft for refinement (**no product fix implemented**)  
**Branch:** `cursor/cgc-k8s-oom-plan-5b38`  
**Goal:** A codesearch service we can **rely on** for agent search + AST/symbol traversal across real customer repos — not a one-off unblock for kubernetes. Kubernetes is only the failing example that exposed the design limit.

**Product constraints (from thread):** Prefer root-cause reliability over patch stacks; do not split indexing into a new microservice; do not downgrade CGC if we keep it briefly; async/retry/lifecycle are optional resiliency only.

Ephemeral CGC evidence (agent VM, not committed): `/tmp/cgc-oom-verify/results/SUMMARY.md`.

---

## 0. Decision

| Option | Verdict |
|--------|---------|
| **A. Bend CGC** (ignores, path-scoped GraphBuilder, fight `all_file_data`) | **Reject as strategy.** May buy tip-advance correctness; does not make cold full indexes trustworthy on monorepos; more CGC footguns likely after the next upgrade. |
| **B. SCIP + ast-grep** (+ keep Zoekt) | **Choose.** Battle-tested, scales, matches the thin tool surface we actually expose, removes Kùzu/Python indexer complexity from the reliability path. |

**Kubernetes lesson:** CGC CLI retains full-repo parse payloads for linking; real Go slices already hit ~11.7 GB RSS (`pkg/controller`). That is a **class of repos** problem, not a single-repo quirk.

---

## 1. What we need from codesearch

Today’s agent stack already splits concerns:

| Need | Today | Target |
|------|-------|--------|
| Text / regex / rough `sym:` | Zoekt | **Keep Zoekt** |
| Precise defs / refs / callers / callees | CGC → Kùzu (`graph_*` tools) | **SCIP** |
| Structural AST patterns (“find this shape”) | Mostly absent | **ast-grep** |
| File read / list | Existing tools | Unchanged |

Exposed graph tools are only `graph_find_symbol`, `graph_get_callers`, `graph_get_callees` (plus internal primitives in `cgc_graph_query.py` not all wired as explorer tools). Migration cost is bounded by that surface — not by “replace every CGC feature.”

---

## 2. Why not bend CGC (for a reliable service)

1. **Design:** full index keeps `all_file_data` in memory through linking — peak scales with corpus size × AST richness.  
2. **Ops:** tip advance via plain `cgc index` **skips**; `--force` re-OOMs. GraphBuilder updates are medium upgrade-risk and still leave cold builds broken.  
3. **Product:** fixing one failure mode (watchers → logs → force → ignores → streaming fork) is the patch treadmill we already dislike.  
4. **Goal mismatch:** “rely on codesearch” ≠ “make CGC survive kubernetes once.”

Optional **stopgap only** (if production is on fire before SCIP ships): path-scoped updates + ignore policy — **time-boxed**, no investment in streaming forks of `pipeline.py`.

---

## 3. Target architecture (one codesearch service)

```text
POST /index
  → clone / checkout          (unchanged)
  → zoekt-index               (unchanged)
  → scip indexers (by lang)   → index.scip (or shards) on disk beside checkout
  → (no Kùzu / no cgc index)

Query:
  → Zoekt RPC                 text / sym:
  → SCIP reader               definition / references / implementations
  → ast-grep on checkout      structural patterns (on-demand; no global RAM graph)
```

Still **one** service, shared checkout disk (Zoekt + SCIP artifacts). No separate indexer fleet required for v1.

### Agent tools (keep contracts where possible)

| Tool | Backend |
|------|---------|
| `search` / Zoekt `sym:` | unchanged |
| `graph_find_symbol` | SCIP definitions (rename later if desired) |
| `graph_get_callers` | SCIP references **to** symbol |
| `graph_get_callees` | SCIP references **from** symbol range / outgoing |
| new: structural search | ast-grep |

Semantic note: SCIP “callers/callees” are reference-based (usually more precise than CGC’s heuristic CALLS). Document the difference in tool descriptions.

### Language coverage (explicit allowlist)

Ship indexers for languages we care about first (e.g. Go, TypeScript/JavaScript, Python, …). Missing indexer → clear “structural nav unavailable” rather than OOM. Map customer language mix before GA.

---

## 4. What we lose / accept

| Loss | Mitigation |
|------|------------|
| One-shot `cgc index .` polyglot | Per-lang SCIP indexers; detect languages from tree |
| Free-form Kùzu Cypher / rich IMPORTS·CONTAINS graph | Not used by current explorer tools; rebuild later only if product needs |
| CGC inheritance / trace_path helpers | SCIP relationships + limited BFS over refs; or defer |
| Existing `.kuzu` artifacts | Discard on cutover; reindex |

---

## 5. Migration outline (TDD-first)

### Phase 0 — Spec & failing tests

1. Freeze tool JSON contracts for the three `graph_*` tools.  
2. Fixture repos (small Go/TS/Python) with golden def/refs/caller expectations.  
3. Monorepo smoke gate: kubernetes (or similar) **must** index under memory ceiling where CGC fails — CI or nightly, not committed tree.

### Phase 1 — SCIP index path in codesearch

1. Dockerfile: install chosen SCIP indexers (not CGC/kuzu).  
2. After Zoekt: run indexers → write SCIP artifact under checkout/cache layout.  
3. Fail `/index` if required indexer fails (same fail-closed stance as today’s CGC).  
4. Tip advance: re-SCIP changed packages or full SCIP (measure; SCIP is built for this class of problem).

### Phase 2 — Query adapter

1. Replace `executeGraphPrimitive` / `cgc_graph_query.py` with SCIP-backed implementation.  
2. Keep HTTP `/graph` shapes stable for backend.  
3. Green fixture tests; update integration tests that currently spawn `cgc`.

### Phase 3 — ast-grep tool

1. Add agent tool for structural queries.  
2. Document when to use Zoekt vs SCIP vs ast-grep (planner hints).

### Phase 4 — Remove CGC

1. Drop pip/Python CGC, Kùzu paths, `cgcIndex.ts`, related Dockerfile bits.  
2. Update AGENTS.md / docs.  
3. Optional ADR: structural intelligence = Zoekt + SCIP + ast-grep.

### Optional resiliency (unchanged stance)

Async `/index`, retry classification, zoekt-vs-graph lifecycle flags — useful later, not the reliability core.

---

## 6. Effort / complexity (honest)

| | Bend CGC | SCIP + ast-grep |
|--|----------|-----------------|
| Near-term code churn | Lower | Higher |
| Ongoing complexity | High (compensating machinery keeps growing) | Lower (delete Kùzu/CGC bridge) |
| Reliability vs monorepos | Poor | Good |
| Fit to “rely on codesearch” | No | Yes |

**Overall simpler for the stated goal:** SCIP + ast-grep, even though the first PR is larger than another CGC patch.

---

## 7. Open questions for refinement

1. **Language allowlist** for v1 SCIP indexers?  
2. **SCIP storage layout** next to Zoekt (per-checkout file vs shared index dir)?  
3. Tip advance: always full SCIP reindex vs incremental (depends on indexer support)?  
4. Do we keep `graph_*` names or rename to `scip_*` in the same change?  
5. Any stopgap CGC deploy needed before SCIP lands, or freeze CGC investment now?

---

## 8. Appendix — CGC verification (why we rejected A)

| Finding | Detail |
|---------|--------|
| Browser WASM | Live parse, not k8s bundle; **not** CLI/Kùzu parity; not a server replacement |
| Skip vs `--force` | Plain `cgc index` skips when already indexed; partial tip path is a no-op |
| Discovery | ~31k files default on kubernetes vs ~11–12k browser-like |
| RSS | `pkg/controller` ~619 files → **~11.7 GB** mid-run (CGC 0.5.3 / kuzu 0.11.3) |
| Schema | `DbColumn` / `RedisKeyPattern` composite PK errors on latest stack |

Versions measured: **codegraphcontext 0.5.3**, **kuzu 0.11.3**.

### Key legacy code pointers (to delete or replace)

| Area | Location |
|------|----------|
| `--force` policy | `apps/codesearch/src/domain/indexing/cgcIndex.ts` |
| CGC spawn | `apps/codesearch/src/domain/indexing/service.ts` |
| Graph query | `apps/codesearch/scripts/cgc_graph_query.py` |
| Agent tools | `apps/backend/src/tools/codegraphTools.ts` |
| Dockerfile CGC | `apps/codesearch/Dockerfile` |
