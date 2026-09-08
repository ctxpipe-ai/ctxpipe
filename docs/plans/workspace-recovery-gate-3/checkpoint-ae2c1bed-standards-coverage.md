# Standards coverage — `ae2c1bed69cea1c6724b05d8ae1ce7a659465b42`

## Identity and method

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target `ae2c1bed69cea1c6724b05d8ae1ce7a659465b42`; merge base equals the fixed base.
- Used only pinned `git diff`, `git log`, `git show TARGET:path`, `git grep TARGET`, and `git ls-tree`. The range has 26 commits and 1,568 changed paths.
- The `a7129f19...ae2c1bed` increment has 64 paths: 17 production paths, five tests, seven ADR/plan/review paths, and 35 saved evidence files.
- Applied root/backend `AGENTS.md`, source-connectors, TDD/mocking, Drizzle conventions, ADR-027/028/033, accepted status/audit, and every supplied Fowler smell. The accepted recovery design supersedes the old source-connectors mechanical `commitFiles` exception. Tool-enforced matters were excluded.
- Read-only: no repository edits, test processes, branch changes, pushes, or delegation.

## Incremental changed surface

- Extraction domain/admission: new `domain/workspaces/extraction.ts`; changed write command, write-job intent, write-job schema/model, enqueue dispatch, extraction workflow, extraction/export native contracts, and path/cutover loader.
- Connector review fixes: shared connector owner model, config enqueue, Linear/Notion/Confluence canonical rendering, Notion/Confluence config workflows, Atlassian/Confluence models and route, native config/admission tests.
- Documentation/evidence: ADR-033, status/audit, prior pinned reports, three type observations, and committed native/type logs.

## Extraction interface and caller ledger

- `workspaceExtractionSchema` strictly defines repository ID/URL, 40/64-character source SHA, object payloads, and claim edges. It is the single runtime schema used by `workspaceWriteJobInputSchema` and `workspaceExtractIngestInputSchema`; `WorkspaceExtraction` types the write command, job payload, Drizzle JSON payload, and persistence model.
- `writeJobIntentPayload` and `enqueueInputFromPausedJob` preserve the batch. `persistBoundWriteJob` stores it and compares it with `isDeepStrictEqual`; `completedWorkspaceWrite` repeats the comparison before replaying a completed result.
- `enqueueWriteJob` gives `extract_ingest` a dedicated typed branch: it parses the required batch, binds the exact revision/batch, starts `workspaceExtractIngest` with the job ID as idempotency key, and rejects old inputs without a batch. No production producer calls this branch yet; that handoff is declared open.
- `workspaceExtractIngest` validates the strict command, claims the same immutable payload, loads only completed path identity/migration cutover from PostgreSQL, acquires Git, renders from `input.extraction`, records paths, and follows native no-op/stage/validate/commit/broker/semantic/hydrate/completion steps.
- `loadExtractionPathIdentity` performs one repeatable-read transaction over current-binding completed paths and export cutover. It does not query object, claim, graph, or embedding content.
- Existing `planKnowledgeProjection` remains the pure Git rendering engine. The workflow currently adapts each extraction object/claim to its legacy export row shape inline; this is the Feature Envy judgment.
- `sourceSha`, repository ID, and URL are durably captured and compared but producer validation/use remains explicitly open; no omission finding was raised for that unfinished surface.

## Connector interface and caller ledger

- `readBinding` now parses Linear/Notion/Forge config through `connection-config.ts`; `configWithLifecycle` serializes Linear/Notion updates. Omitted `enabled` retains the provider-schema default, closing the prior blocker.
- `enqueueConnectorConfigSync` hashes canonical Linear scopes, rendered Notion YAML, or `confluenceSpaceSelection`, then uses shared prepare/enqueue-recovery/activation. Its five route callers remain Linear setup/retry, Notion setup/retry, and Confluence setup.
- Notion and Confluence config workflows now load repository-bearing bindings, persist the generation/binding CAS in one durable step, close a stale created PR in a separate durable step, and fail the stale workflow. Provider API work stays outside SQL transactions.
- Confluence PATCH persists/compares space selection before enqueue. Its local comparison normalizer differs from `confluenceSpaceSelection` for `[]` versus `null`, producing the documented finding.
- Disabled Confluence targets report `configProposalEnabled: false`, so the HTTP save skips proposal admission. Linear/Notion/Confluence proposal keys otherwise ignore ordering and provider metadata absent from rendered config.

## Proof disposition

- Inspected the committed claims for 55 native extraction/config cases, 29 replay/render/route cases, backend types with 138 acknowledged diagnostics, proof policy, and scoped Biome. Nothing was rerun.
- Extraction proof covers poisoned DB content, immutable job/workflow payload, differing-payload replay rejection, owner prose and metadata preservation, collision/path identity, migration cutover, and no-op replay.
- Connector proof covers omitted-enabled legacy recovery, stale PR cleanup, reordered proposal selections, irrelevant Notion URL metadata, and disabled Confluence save. The equivalent-proposal cases do not cover `selectedPageIds: []` versus `null`.
- No added test introduces an owned-module `vi.mock`; direct DB access arranges or observes durable state.

## Fowler baseline disposition

- New: Confluence canonicalizer **Duplicated Code**, extraction adapter **Feature Envy**, and `sourceId` **Mysterious Name**.
- Remaining: dual-purpose owner **Mysterious Name**, connector **Repeated Switches**, and four acknowledged **Duplicated Code** instances (connector admission, GitHub credential issuance, conversation preparation/publication, typed workspace admission).
- Suppressed: provider workflow similarity because ADR-033 requires explicit typed lifecycle steps.
- No actionable Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, or Refused Bequest found.
- Declared repository producer/DB-graph removal/retraction/endpoint/bounds/recovery, config capture/event ordering, unborn bootstrap, admission uncertainty, model bounds, and final audit were not reported as surprise omissions.

## Counts

- Documented-standard violations: **1**
- Fowler heuristic smells: **9**
- Implemented-scope blockers: **1**
