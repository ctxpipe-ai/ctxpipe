# Standards coverage — `db628699f5b15a7fba03589fbfbe7746b54a723e`

## Review identity and method

- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Pinned target: `db628699f5b15a7fba03589fbfbe7746b54a723e`
- Inspected `git diff BASE...TARGET`, `git log BASE..TARGET`, and target blobs with `git show TARGET:path`; no moving-worktree content was used.
- Enumerated the full 16-commit range. The increment after the prior reviewed checkpoint is `db628699 Gate 3: plan native rename repair and broker Linear mirror children`.
- Read pinned root `AGENTS.md`, backend `AGENTS.md`, ADR-027/033, Gate 3 status and write-path audit. Applied the previously supplied TDD/mocking rules, source-connector override, code-review procedure, and full named Fowler smell baseline.
- Read-only review: no repository mutation and no heavyweight test execution. Tool-enforced whitespace output and recorded diagnostic-log formatting were excluded.

## Implemented production surface and callers

### Rename planning and shared Git acquisition

- `hydrate-write-planner.ts`: added the discriminated `HydrateWriteRequirement`, including immutable `rename_rewrite.previousSha`.
- `workspace-hydrate.ts:135-233`: captures the previous active SHA only across the same full revision binding, reads current and previous trees with native Git, computes similarity-based repair, reserves, and admits the typed command.
- `workspace-write-planning.ts:11-134`: sole reservation consumer of `HydrateWriteRequirement`; persists and returns `previousSha`, including queued/paused replay, under the existing short transaction and cap/non-shrinking rules.
- `services/git/pack.ts:118-143`: new `readGitPackFromRemote`. Callers traced in `write-command.ts`, `workspace-hydrate.ts`, and `capture-connector-mirror.ts`; the earlier acquisition implementation was removed from `write-command.ts`.

### No-op revalidation

- `write-broker.ts:235-256`: removed the writable-status requirement while retaining refreshed-remote binding comparison and the atomically loaded workspace revision comparison.
- All callers traced: bootstrap, claims upgrade, connector mirror, extract ingest, file edit, import-key cleanup, link/unlink, migration export (including handoff), ops folder map, rename rewrite, semantic merge paths, and valid-from persistence. `captureSemanticHandoff` also uses the helper.
- Native proof read in `write-pause-native.contract.test.ts:29-145`: real Git read is held across a PostgreSQL permission revocation; completion is no-op, no commit, no write-token request.

### Linear native parent migration

- `capture-connector-mirror.ts:18-80`: normalized target lookup, refreshed native revision, connector binding assertion, transient read credential, immutable pack, config/path extraction; return shape is non-secret.
- `connector-mirror.ts`: provider reader dispatch is shared at module scope. `assertConnectorMirrorBinding` callers traced through connector capture plus acquisition and both broker pre-push checks.
- `services/linear/sync.ts:113-159`: full/incremental functions now return captured files/deletions/failures and perform no GitHub write. Each has one production caller: its respective Linear parent.
- `linear-sync-content.ts:52-198`: initial-sync capture, fresh authorization load, provider capture, typed child, ingestion, and finalization. Failure catch is limited to the context step, so native child suspension is not projected as terminal failure.
- `linear-sync-entity.ts:57-210`: live-phase equivalent with typed child and ingestion.
- `linear-connector.ts:354-465`: refresh precondition, SQL snapshot, external refresh, and locked CAS update traced; no network call is inside an org SQL scope.
- Typed mirror call sites traced: the two Linear parents, production write admission, and native mirror contracts.

## Proof and support surface

- `linear-mirror-native.contract.test.ts`: real OpenWorkflow/PostgreSQL/native Git full and entity paths, one child, one commit, deletion and config preservation, setup transition, durable secret scan.
- `hydrate-planner-native.contract.test.ts`: added same-binding previous/current rename planning, deduplication, and read-only/no-push coverage; retained cap, pause, and multi-kind checks.
- `write-pause-native.contract.test.ts`: added read-only no-op race proof and removed the two direct console diagnostics.
- `services/linear/sync.test.ts`: retained config-PR behavior while obsolete owned content mocks were removed; the two obsolete workflow parent mock suites were deleted.
- `native-hydration-fixture.ts`: added third-party GitHub Contents fixture response, an allowed external-boundary fake.
- `scripts/ci/test-suite.mjs`: backend timeout only increased from 600 to 1,200 seconds with a reason tied to real durable waits; no allowance was added.
- ADR/status/audit/checkpoint evidence updates were inspected for agreement with the implementation and their explicit intermediate-state claim.

## Fowler baseline disposition

- Reported: **Duplicated Code** across the two Linear parent workflows.
- Considered and not found as actionable in implemented scope: Mysterious Name, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest.
- The provider dispatch map is a single dispatch point, and the shared Git helper has three concrete callers, so neither is speculative or a repeated-switch smell.

## Declared scope exclusions

The audit explicitly leaves connector setup failure/finalization and late binding races, Notion/Slack/Confluence migration, export/extraction follow-up planning and legacy extraction removal, empty-repository initialization, config-PR/conversation broker guards, remaining provider/topology work, alternate writer removal, and generic writer deletion open. These were not presented as new checkpoint omissions or Gate 3 acceptance failures.

## Outcome

- Documented-standard violations: **0**
- Heuristic smells: **1**
- Implemented-scope blockers: **0**
