# Standards coverage — `6bae4242686cc2438a3ac0fa326ca44e748f0b7d`

## Identity and method

- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Pinned target: `6bae4242686cc2438a3ac0fa326ca44e748f0b7d`
- Verified merge base equals the fixed base and enumerated all 17 commits. New increment: `6bae4242 Gate 3: broker remaining connector parents and fence captured scope`.
- Used pinned `git diff`, `git log`, `git show TARGET:path`, and `git grep TARGET`; no moving worktree content.
- Read root/backend `AGENTS.md`, ADR-027/028/033, source-connectors, status, write-path audit, and applied the previously supplied TDD/mocking and full Fowler smell baseline. The accepted recovery design overrides source-connectors’ old mechanical `commitFiles` sentence.
- No repository edits or heavyweight tests. Tool-enforced formatting was excluded.

## Changed production interfaces and callers

### Captured target and scope fence

- `capture-connector-mirror.ts:18-92` now accepts a mirror without `configBlobSha`, resolves and validates the binding, reads the immutable Git tree, and returns the exact config blob SHA or explicit absence.
- All seven production callers traced: Linear full/entity, Notion full/entity, Confluence full/space, and Slack mention.
- `connector-mirror.ts:18-117` makes `configBlobSha` mandatory and adds `assertConnectorMirrorScope`.
- Scope validator callers traced: `write-command.ts:116` (acquisition), `write-broker.ts:102` (publication), and `write-broker.ts:266` (no-op/semantic refresh). Binding validator remains at capture, acquisition, and broker checks.
- Typed `ConnectorMirrorSource` propagation traced through `write-job-intent.ts`, persisted job payload, connector workflow input, semantic handoff, paused replay, and enqueue dispatch.
- `write-mirror-native.contract.test.ts:506-616` proves config A cannot delete content after config B publishes and that failure occurs before semantic-child creation. Reset, pause, binary, managed-path, and semantic handoff cases were also inspected.

### Notion parents

- `notion-sync-content.ts:40-164`: immutable target/config capture, fresh credential load, provider-only capture, typed mirror child, ingestion, setup finalization.
- `notion-sync-entity.ts:40-172`: live binding gate, same capture boundary, incremental provider capture, typed child, conditional ingestion.
- `services/notion/sync.ts:160-383`: removed Git reads/writes from full and incremental capture; returns files and deletions from the captured tree.
- Production callers of `captureNotionContent` and `captureNotionIncrementalContent` are exactly the respective parents.
- Token update caller ledger includes both capture callbacks and the existing resource-search route. The nested transaction/system-DB ownership issue is reported in the main review.

### Confluence parents and reconciliation

- `confluence-sync-content.ts:30-138` and `confluence-sync-space.ts:27-136`: capture immutable config/tree before provider fetch, reload transient Forge credentials, invoke typed child, then record provider state.
- `captureConfluenceContent` has exactly those two production callers.
- `services/confluence/sync.ts:116-280`: provider capture returns files/delete paths/sync markers; full deletion occurs only when `pagesFailed === 0`; space mode restricts deletions to its managed space prefix; single-page upserts do no global orphan pass.
- `confluence-sync-target.ts:302-331`: completed moves live; failed/partial moves `sync_failed`. Remaining finalization CAS is explicitly open.

### Slack intent capture

- `slack-mention-agent.ts:39-162`: durable target, working status, model intent, deterministic provider capture, typed child, then final status. Fresh credentials are loaded inside each provider/status step; the durable values are team/repository/captured Git identity and content.
- `services/slack/mention-agent.ts:85-143`: model tool mutates only local `captureRequested`; it cannot write Git or fetch provider content.
- `services/slack/sync.ts:178-286`: captures deterministic files and metadata, excludes the working status, and contains no Git mutation. Each changed helper has the Slack parent as its only production caller.

### Typed child call ledger

`workspaceConnectorMirror.spec` production callers are the seven connector parents plus `enqueue-workspace-write-commit.ts`. Native contracts register the same typed workflow for Linear, Notion, Confluence, Slack, and broker/race coverage.

## Test and support changes

- New real PostgreSQL/OpenWorkflow/native Git contracts: `notion-mirror-native.contract.test.ts`, `confluence-mirror-native.contract.test.ts`, and `slack-mirror-native.contract.test.ts`. They verify one native child/commit, config preservation, scoped deletion, credential absence from durable run/step data, setup state, and Slack status ordering/intent behavior.
- `write-mirror-native.contract.test.ts` adds mandatory scope identity, stale-scope, reset, semantic handoff, paused binary, and path validation coverage.
- Notion activation mock replaced by real PostgreSQL/OpenWorkflow deduplication in `enqueue-notion-push-sync.test.ts`.
- Retired owned mocks: Notion full/entity parents, Slack parent, and Slack sync. Pure Slack parsing/conversion/config tests remain.
- Fixture extensions are third-party HTTP boundaries (Notion, Confluence, Slack, model), allowed by mocking policy. Tip-check assertions were narrowed to the intended workflow and updated for authoritative read-only state.
- Evidence read from pinned status/log inventory: 27 tests across eight native/provider/converter suites; all four CI regression checks; scoped Biome; proof policy; backend type baseline reduced 141→140 with no new diagnostic.

## Fowler baseline disposition

- Reported: **Duplicated Code** across provider full/incremental parent orchestration; **Primitive Obsession** for a second, narrower Git object-ID validator.
- Considered, no additional actionable implemented-scope instance: Mysterious Name, Feature Envy, Data Clumps, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest.

## Declared exclusions

Connector setup failure projection, finalization/binding CAS and retry markers; remaining config/session/default writers and broad credentials; export/extraction planning and legacy removal; empty-repo initialization; provider topology; generic writer deletion; and terminal Gate 3 acceptance remain explicitly open. They were not counted as checkpoint omissions.

## Counts

- Documented-standard violations: **2**
- Heuristic smells: **2**
- Implemented-scope blockers: **2**
