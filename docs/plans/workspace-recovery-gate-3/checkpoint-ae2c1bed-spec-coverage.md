# Gate 3 extraction-input Spec coverage ledger

## Review identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Pinned target: `ae2c1bed69cea1c6724b05d8ae1ce7a659465b42`
- Examined `git diff BASE...PIN`, `git log BASE..PIN`, and `git show PIN:path`; no moving-worktree source was used.
- Read-only review. No repository mutation, test process, network action, or delegation.

## Governing requirements checked

- `docs/plans/workspace-chat-recovery.md:642-659`: typed OpenWorkflow jobs, explicit durable steps, native Git, deterministic transforms, retry proof, and one durable result.
- `.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:11-14,47-48,68-77,96-110`: Git is canonical; DB projection changes through hydrate; one job/at-most-one commit/no-op; default-branch/semantic handling; extract ingest is its own concern.
- `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:11-15,17-26,30-31`: immutable native command data, Git identity, path-assignment rules, replay/ownership, binding checks, and the new validated-extractor-batch/config decisions.
- `docs/plans/workspace-recovery-gate-3/status.md:476-484` and `write-path-audit.md:28-40`: checkpoint claims and explicitly unfinished producer/retraction/endpoint/bounds/recovery work.

## Increment surface reviewed (`a7129f19...ae2c1bed`)

### Extraction command and persistence

- `domain/workspaces/extraction.ts`: new strict outer/object/claim schema. Checked repository URL, source SHA, JSON payload, confidence and strictness. Missing batch bounds and endpoint normalization are explicitly open. Duplicate object identity is the reported defect.
- `domain/workspaces/write-job-intent.ts`: extraction crosses admission payload creation and paused-job reconstruction; the generic schema leaves it optional while the typed workflow schema requires it.
- `db/schema/workspaces.ts`, `models/workspace-write-jobs.ts`: extraction is retained in the JSON command payload; both initial bind and workflow claim compare it deeply. Existing job identity cannot be replayed with changed captured content.
- `domain/workspaces/write-command.ts`: completed replay performs the same deep equality check before returning an old result.
- `openworkflow/enqueue-workspace-write-commit.ts`: `extract_ingest` parses the typed command before persistence, persists the parsed batch, then starts the typed workflow with job ID idempotency.
- `models/workspace-export.ts`: extraction now reads only binding-scoped completed path identity and migration cutover in repeatable read; legacy object/claim projection reads remain confined to migration export.
- `openworkflow/workflows/workspace-extract-ingest.ts`: traced completion replay → claim → path metadata → acquire/pause → Git read → projection → path-result persistence → no-op refresh → stage/validate/commit → broker/semantic handoff → publication/hydration. It does not query content/claim projection tables. Native Git files remain content authority.
- `domain/workspaces/migration-export.ts`, `services/git/write-tree.ts`: traced duplicate identity through allocation, map overwrite, rendering and sequential index writes. Compared with existing extractor deduplication semantics in `graphs/codeIngestionGraph/nodes/deduplicateAndStore.ts:266-313` and `retrieval/services/retrievalObjectWrite.ts:120-140`.

### Config corrections

- `openworkflow/enqueue-connector-config-sync.ts`, `services/linear/config-yaml.ts`, `services/confluence/config-yaml.ts`: proposal idempotency hashes canonical selections (sorting and default normalization); Notion uses canonical rendered YAML.
- `models/connector-content-sync.ts`: lifecycle reads and writes parse/serialize provider configs, so omitted stored fields receive provider defaults rather than raw-object semantics.
- `openworkflow/workflows/notion-sync-config.ts`, `confluence-sync-config.ts`: a failed generation/binding finalization is observed as a boolean, followed by its own `close-superseded-config-pr` durable step and terminal failure. Cleanup uses captured repository/connection/PR identity.
- `models/atlassian-connector.ts`, `models/confluence-sync-target.ts`, `routes/v1/connectors-atlassian.ts`: disabled Confluence targets return `configProposalEnabled=false`; the HTTP save gates proposal admission on it.
- Associated native/config/render/route tests and committed proof logs were read for claimed scenarios. All new extraction fixtures use unique object keys, leaving the finding uncovered.

## Caller and adversarial trace

- Production `enqueueWriteJob` calls and workflow discovery were searched. There is no current repository-ingestion producer for the new batch, consistent with the declared open handoff.
- Rechecked paused replay, completed replay with changed payload, poison-DB isolation, no-op, existing file/path identity, same-name path collisions, semantic handoff, broker CAS, and hydrate enqueue at the changed interfaces.
- Claim refs may currently be IDs or deduplication keys in `graphs/codeIngestionGraph/schemas.ts:43-54`; native endpoint resolution is explicitly open and is recorded as remaining scope, not a new finding.
- Omitted-object Git retraction, producer transaction/capture boundary, payload limits, legacy queued producer recovery, and producer private-signal handling match the declared OPEN list and were not counted as defects in this checkpoint.

## Result

- Findings: **1 P1, 0 P2, 0 P3**.
- Prior a712 config findings: verified closed; erroneous Confluence silent-CAS claim remains withdrawn.
- This is an intermediate checkpoint review, not Gate 3 acceptance.
