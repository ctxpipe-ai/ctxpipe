# Spec coverage — Gate 3 checkpoint 529b0bfd

## Review boundary

- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.
- Pinned target: `529b0bfd08d1e73618285cc5867c4859062b2c14`.
- Inspected `git diff BASE...TARGET`, `git log BASE..TARGET --oneline`, and committed blobs via `git show TARGET:path`; no moving worktree content was used for product conclusions.
- Applied `docs/plans/workspace-chat-recovery.md` Gate 3, tickets 02/09/10/11/18, ADR-033, and pinned Gate 3 status. The code-review skill's Spec brief was followed. No implementation was changed and no native or heavyweight suite was run.

## Prior finding rechecks

### HTTP admission — resolved

- `apps/backend/src/routes/v1/repositories.ts:320-346` awaits `enqueueRepositoryIngestionWorkflow`, returns 503 when admission cannot be confirmed, and rereads the persisted row after acceptance so the response exposes queued state.
- `apps/backend/src/routes/v1/connectors-atlassian.ts:992-1005` does the same for a saved Confluence sync target.
- `apps/backend/src/models/atlassian-connector.ts:717-789,810-855` reports ingestion for both newly created and existing enabled targets whose `lastIngestedHash` is still null, allowing the 503 request to be retried against the saved repository.
- `apps/backend/src/openworkflow/enqueue-repository-ingestion.ts:14-44` reserves one immutable request, uses its idempotency key, recovers a lost native response by owner lookup, and activates queued state only after an owner is known.
- Reviewed native HTTP coverage in `repository-admission-native.contract.test.ts`; did not rerun it.

### Stale source index/progress — resolved except degraded publication finding

- `repository-ingestion.ts:246-259` passes the current request identity into the child index workflow.
- `repository-index.ts:157-267` recovers/validates current parentage, creates `rev:<sha>`, scopes phase JWTs to repository+SHA, and checks current request/binding before each phase and request-owned progress update.
- `repository-ingestion-requests.ts:175-261` supplies the SQL write condition and recursive native ancestry recovery. `setRepositoryIndexingStep` applies the request predicate itself (`repositories.ts:512-546`), so the assertion/update gap cannot overwrite a newer owner's progress.
- Codesearch phase paths, SCIP shards, and Zoekt identity include the checkout key (`indexPhases.ts`, repository path helpers, and `zoekt/shardPrefix.ts`). Immutable workers suppress legacy canonical progress writes (`phases.ts:473-481`).
- `phaseMarkCheckoutIndexed` binds its update to repository/org/checkout key and errors on UPDATE 0 (`phases.ts:674-699`). Older successful checkouts therefore cannot replace a newer ordinary-read pointer merely by finishing late.
- Remaining defect: phase completion does not mean the combined index was successful when Zoekt was deliberately caught. See main report.

### Follow-up default selection — resolved

- `repository-ingestion.ts:608-633` passes `input.targetBranch`, preserving null/default instead of freezing the formerly resolved branch.
- `repository-follow-up-default-native.contract.test.ts` covers restart plus changed default separately from an explicitly selected branch.

### Equivalent evidence identity — resolved

- `retract-extraction.ts:13-45` normalizes repository URLs, decodes the URL fragment once, and resolves relative paths against the claim subject while rejecting traversal/cross-repository relative evidence.
- `plan-extraction.ts:68-80` uses that canonical evidence path in merge identity; generated source links encode each path segment (`:87-96`).
- `migration-export.ts:510-687` merges claims by actual owner path and can update referenced existing subjects without fabricating duplicate object payloads.
- Checked the retained legacy encoded-fragment/retraction evidence listed in pinned status; no test was rerun.

## New interfaces and caller tracing

### Published checkout selection

- Backend repository list/get/search selects a checkout using `publishedRepositoryCheckoutKey` (`models/repositories.ts:54-59,125-166`; `retrieval/services/codeSearch.ts:145-170`).
- Codesearch mirrors the SQL selector (`domain/repositories/service.ts:19-81`) and applies it to unscoped file/list/tree/glob, structural, graph, and lexical routes (`routes/repo.ts:508-705`, `routes/structuralSearch.ts:83-130`, `routes/graph.ts:76-185`, `routes/search.ts:59-165`).
- Explicit source/workspace scopes take precedence through `checkoutKeyFromAuth`; index admission additionally requires the request target SHA to equal the authenticated revision (`auth/jwt.ts:21-68,165-184`).
- Search rows are filtered back to authorized repository/SHA pairs before Zoekt IDs are accepted (`routes/search.ts:68-125`). This avoids cross-repository access when multiple repositories share the same `rev:<sha>` suffix.

### Captured extraction reads

- `source-revision-context.ts` validates SHA and rejects a tool call for a repository other than the captured one.
- All three extraction callback groups establish the context with the resolved source SHA (`repository-ingestion.ts:313-478`; `withIngestAgentContext.ts:18-50`).
- File/list/glob clients mint repository-revision JWTs and reject conflicting explicit workspace/SHA extras (`codesearchClient.ts:42-93`).
- Search, structural, and graph tools consume the same context (`tools/codesearchZoekt.ts`, `tools/structuralSearch.ts`, `tools/codesearchGraph.ts`). Source-scoped Zoekt search omits caller-supplied numeric IDs and lets the service derive the exact row.
- Generic conversation retrieval continues to use published or explicit workspace projection selection rather than inheriting extraction state.

## Adversarial scenarios checked

- Older A finishes after published B: isolated paths plus B's durable pointer retain B.
- Extraction captured A after B publishes: source JWT continues to read A for file, lexical, structural, and graph tools.
- Request superseded between assertion and progress SQL: request predicate on the update prevents overwrite.
- Source superseded during a long remote phase: the stale phase may finish only inside its immutable checkout; the next durable step fails the owner fence and cannot publish current status/Git.
- Default branch changes after a restarted ingestion: null stays null and follow-up resolves the new default; an explicit branch stays explicit.
- Admission insert fails after repository/config persistence: 503 is returned; retry reuses the saved entity and request key.
- Legacy raw URL, percent-encoded URL, and relative evidence for the same path: canonical merge identity converges to one source history.
- Zoekt B fails while SCIP B succeeds: B is still marked/index-selected, displacing complete A. Reported P1.

## Declared open scope, not findings

Gate 3 status still declares the live producer acceptance journey, remaining config ordering, unborn bootstrap, allocation crash proof, workspace/semantic enqueue uncertainty, cumulative duplication cleanup, final CI/reviews, and later gates open. The separately running Kubernetes immutable-checkout memory result was not treated as available evidence or as a defect.
