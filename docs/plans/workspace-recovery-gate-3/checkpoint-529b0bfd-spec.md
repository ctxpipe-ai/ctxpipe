# Spec review — Gate 3 checkpoint 529b0bfd

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...529b0bfd08d1e73618285cc5867c4859062b2c14`.

## Finding

**P1 — A failed Zoekt build replaces the last complete published index.** Ticket 11 says the indexed SHA represents “Zoekt+SCIP as one” and is written only “after a successful index” ([`.ai/scratchpad/git-backed-projects/issues/11-project-revision-and-freshness.md:76`](git-show:529b0bfd:.ai/scratchpad/git-backed-projects/issues/11-project-revision-and-freshness.md#L76)); on failure, “Keep serving the last complete Zoekt+SCIP index” ([line 96](git-show:529b0bfd:.ai/scratchpad/git-backed-projects/issues/11-project-revision-and-freshness.md#L96)). Instead, `repository-index` converts a Zoekt exception into `searchIndexOk: false` and continues (`apps/backend/src/openworkflow/workflows/repository-index.ts:305-325`). The later merge endpoint unconditionally records that checkout as indexed (`apps/codesearch/src/routes/indexPhases.ts:480-485`), and the parent’s `complete_with_issues` path still writes `lastIngestedHash` to the new SHA (`apps/backend/src/openworkflow/workflows/repository-ingestion.ts:579-595`; `apps/backend/src/models/repositories.ts:471-499`). Ordinary file, graph, structural, and lexical reads then select `rev:<lastIngestedHash>` (`apps/backend/src/models/repositories.ts:54-59`; codesearch mirror at `apps/codesearch/src/domain/repositories/service.ts:76-81`). Trigger: A is published; B’s Zoekt phase fails but SCIP completes. The workflow reports a warning yet switches reads to B’s absent/partial lexical shard rather than serving A. Keep a distinct successfully indexed SHA/read pointer and advance it only after both Zoekt and SCIP succeed; degraded ingestion may retain its warning without publishing B as the complete search checkout.

## Recheck

The four c4caa835 findings are closed: both HTTP callers await retryable admission; index side effects and extractor tools are SHA-scoped; default follow-up selection remains unspecified; and evidence identities normalize relative/URL/encoded paths. Declared remaining Gate 3 inventory and the running Kubernetes memory proof are outside this checkpoint finding count.

**Total: 1 finding (P1).**
