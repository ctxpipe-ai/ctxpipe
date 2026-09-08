# Standards coverage — `4a603c1992a0c69ce06efbb70e3e5b55d12c3a73`

## Identity and method

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target `4a603c1992a0c69ce06efbb70e3e5b55d12c3a73`; merge base equals fixed base.
- Enumerated all 24 commits and 1,463 changed paths using pinned `git log`, `git diff`, `git show TARGET:path`, `git grep TARGET`, and `git ls-tree`. The moving checkout was not used for conclusions.
- Cumulative classification: 119 production source/script paths, 67 tests, ten migration artifacts, 115 non-log docs, 1,139 evidence logs, and 13 other files.
- Applied root/backend `AGENTS.md`, source-connectors, TDD/mocking, Drizzle migration skill, ADR-027/028/033, accepted plan/status/audit, and every supplied Fowler smell. The accepted native broker supersedes source-connectors’ old `commitFiles` mechanical-write instruction. Tool-enforced issues were omitted.
- Read-only: no repository edits, test processes, branch changes, or pushes.

## Incremental surface

The `e94731f3...4a603c19` increment has 96 paths: 21 production TypeScript paths, 11 test paths, two generated migration files, seven plan/review files, 54 proof files, and one ADR change.

Production files reviewed:

- schema/migration: `connections.ts`, generated `20260908184004_stiff_tag` SQL/snapshot;
- models: Atlassian, Confluence target, Linear, Notion, connector finalization, and the expanded connector content-sync owner model;
- workflow runtime/admission: typed OpenWorkflow client, new connector content enqueue helper, Confluence/Notion post-push wrappers;
- six explicit config/content workflows for Linear, Notion, and Confluence;
- Atlassian/Linear/Notion public routes and Linear GitHub push handler;
- native fixture, all changed contract/route tests, deleted config-workflow mocks, status/audit/ADR, and saved evidence.

## Interface and caller ledger

### Shared content owner

- `connectorContentBindingSchema` is consumed by shared prepare/activate/assert/reconcile code and all three content workflow input schemas. Its durable, non-secret fields are provider, repository, branch, provider workspace/cloud, and Atlassian base URL.
- `enqueueConnectorContentSync` has eight production call sites: Confluence and Notion config-push wrappers; Linear and Notion retry routes; Linear GitHub push activation; and the three no-change config workflow tails. It calls `prepareConnectorContentSync`, creates or rediscovers an idempotent native run, then calls `activateConnectorContentSync`.
- `prepareConnectorContentSync` is called only by the shared enqueue helper. It checks enabled/installed state, provider, repository, branch, eligible phase, and current config-key owner before proposing the next generation.
- `findConnectorContentSyncOwner` is called only after enqueue throws; it recovers a run by workflow/provider, org, connection, and idempotency key.
- `activateConnectorContentSync` is called by the shared enqueue helper and as the first durable step of all three content workflows. It row-locks the connection, validates the run and captured binding, publishes generation/owner/`initial_sync`, and supports only bounded generation-zero compatibility.
- `assertConnectorContentSyncBinding` is called in each full-content target-capture step before provider capture. `captureConnectorMirrorTarget` independently checks the generation before Git capture.
- `contentSyncWorkflowRunId` is written only by activation and read by prepare/reconcile. The generated nullable column preserves legacy rows.
- `reconcileConnectorContentSync` remains called by the three setup read models. It selects the exact stored content owner, handles generation-zero legacy inputs, and projects current failed/canceled content or config owners. Config projection joins the completed `capture-config-binding` attempt and compares its binding.

### Config workflow ownership

- Linear, Notion, and Confluence config schemas default legacy `contentSyncGeneration` to zero. Their first step calls `captureConnectorConfigSyncBinding`; changed output persists PR state, while unchanged output durably calls shared content admission.
- Config proposal routes now supply the current claimed generation and required org slug. Generated config-workflow results contain no credential.
- Confluence direct-live finalization is removed. `updateConfluenceSyncTargetPrState` optionally CASes repository/branch plus setup state. Linear closes a created PR if its target CAS fails.
- Forge cloud/base-URL replacement and Linear/Notion provider-workspace replacement advance content generation; token-only refresh does not.
- `lockConnectorFinalizationBinding` now requires an explicit `Db`. Its four callers (three provider finalizers plus Confluence synced-space projection) pass their active transaction.
- Legacy claim/retry helpers now have no production callers; their consolidation is explicitly open and was not reported as Speculative Generality.

### Webhook propagation trace

- Confluence and Notion push handlers await their wrappers; wrapper enqueue failures propagate through `processPushEvent` to Hono, producing a non-2xx response.
- Linear differs: its changed handler catches the same shared enqueue error and returns normally. `processPushEvent` then continues and both authenticated GitHub webhook routes return 200. This is the documented source-connectors violation in the main report.

## Proof disposition

- Inspected claimed final evidence: 113 tests across 13 suites, seven legacy compatibility cases, fresh/upgrade migration checks, backend types at 138 acknowledged diagnostics, policy, and scoped Biome. Nothing was rerun.
- Native coverage includes owner-first crash recovery, lost enqueue response, duplicate and A-B-A activation, concurrent retry, generation-zero restart, provider replacement, current terminal config/content projection, unchanged config admission, stale config, Linear orphan-PR close, and real HTTP/PG/OpenWorkflow boundaries.
- Deleted Linear/Notion config workflow tests and route/webhook mock cases used owned-module substitutes; their replacement contracts run owned collaborators. Direct SQL in these contracts arranges fixtures or observes durable OpenWorkflow ownership rather than replacing the collaborator.
- No proof covers the reported production logger path swallowing a true pre-owner Linear enqueue failure.

## Fowler baseline disposition

- New: possible **Repeated Switches** in the shared connector owner model.
- Remaining: three **Duplicated Code** judgments for GitHub credential issuance, conversation preparation/publication, and typed workspace admission.
- Closed: connector-side admission duplication, `conversationSelection` **Mysterious Name**, and connector binding **Data Clumps**.
- Suppressed: similar provider workflows because ADR-033 requires explicit native lifecycle steps; no generic StepApi owner may replace them.
- No actionable Feature Envy, Primitive Obsession, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, or Refused Bequest.

## Counts

- Documented-standard violations: **1**
- Fowler heuristic smells: **4**
- Implemented-scope blockers: **1**
