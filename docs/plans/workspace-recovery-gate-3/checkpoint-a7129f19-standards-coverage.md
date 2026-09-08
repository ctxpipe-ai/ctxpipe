# Standards coverage — `a7129f1973caea687ae3420fc2e36fe730dd8fa8`

## Identity and method

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target `a7129f1973caea687ae3420fc2e36fe730dd8fa8`; review used only `git diff BASE...TARGET`, `git log BASE..TARGET`, `git show TARGET:path`, `git grep TARGET`, and `git ls-tree`.
- The range contains 25 commits and 1,525 paths. The final `4a603c19...a7129f19` increment contains 88 paths: 20 production paths, seven test paths, nine ADR/plan/review paths, and 52 saved proof files.
- Applied root and backend `AGENTS.md`, source-connectors, TDD/mocking, Drizzle conventions, ADR-027/028/033, the accepted Gate 3 plan/status/audit, and the complete supplied Fowler baseline. ADR-033/accepted recovery overrides the old source-connectors mechanical `commitFiles` instruction. Tool-enforced matters were omitted.
- Read-only: no repository edits, tests, branch operations, pushes, or delegation. Reports alone were written under `/private/tmp`.

## Incremental production surface

- Admission/recovery: new `enqueue-connector-config-sync.ts`, revised `enqueue-connector-content-sync.ts`, new bounded `backfill-connector-content-admissions.ts` and preview/apply CLI.
- Ownership/projection: expanded `connector-content-sync.ts`; Linear, Notion, Atlassian, and Confluence-target models; Confluence service capture input.
- Native workflows: Linear, Notion, and Confluence config workflows plus their content activation steps.
- Entry points: Linear/Notion/Atlassian setup and retry routes, Linear GitHub push handler.
- Proof/docs: seven changed native/route tests, removal of obsolete claim mocks, ADR-033, status/audit, prior pinned review, and saved logs.

## Interface and caller ledger

### Shared owner model

- `connectorContentBindingSchema` is the durable non-secret provider/repository/branch/workspace/cloud identity used by all six config/content workflow schemas, both enqueue helpers, model binding checks, and recovery input validation.
- `prepareConnectorSync` is called by both enqueue helpers and recovery preview. It reads eligibility, current owner, config key, binding, and generation. Its raw `connections.config` handling is the documented finding.
- `activateConnectorSync` is called after admission, as the first durable step of all six provider workflows, by recovery apply, and by native contracts. It locks the connection, verifies the exact native run, generation, binding, and phase, then projects owner/setup state. It now accepts current terminal owners and acknowledges completed config owners without rewinding descendants.
- `findConnectorSyncOwner` is used only by the two enqueue helpers after an uncertain enqueue response. It keys lookup by workflow purpose/provider, organization, connection, and idempotency key.
- `captureConnectorConfigSyncBinding` is called by all three config workflows after activation; it requires the current generation, `awaiting_merge`, and pending flag.
- `reconcileConnectorContentSync` remains called by Linear, Notion, and Confluence setup readers. It locks the connection and projects only a matching current config/content owner, including failed/canceled runs before config capture.
- `contentSyncWorkflowRunId` is still the sole schema column but now stores either config or content workflow ownership. This naming mismatch is the reported Fowler judgment.

### Admission and workflow callers

- `enqueueConnectorConfigSync` has five route call sites: Linear setup/retry, Notion setup/retry, and Confluence setup. It derives an immutable selection hash, prepares intent, starts/re-discovers the typed provider config workflow, then activates the owner. The routes return 409 for rejected competing/stale proposals and 503 for enqueue failures.
- `enqueueConnectorContentSync` is called by Confluence/Notion push wrappers, Linear/Notion retry routes, the Linear GitHub push handler, and all three no-change config tails. It shares model ownership but repeats the outer admission skeleton with config admission.
- Each provider config workflow explicitly performs legacy recovery, activation, binding capture, provider-specific PR work/finalization, and unchanged-config content admission. This visible lifecycle is required by ADR-033, so similarity among provider workflows was not reported as duplication.
- Each content workflow repeats activation before provider capture. Parent connector workflows and mirror children remain bound by the previously reviewed config-blob and generation fences.
- The Linear GitHub handler now rethrows shared admission failure; its callers therefore preserve the source-connectors 5xx retry contract.

### Provider model and SQL ownership

- Linear/Notion claim/release helpers are removed and callers use shared admission directly. Their binding transition functions lock and compare the expected generation before finalizing.
- `patchAtlassianConnectorConfig` owns one org transaction across connection locking, repository/checkout creation, target update, and space replacement. A pending Confluence proposal compares normalized selections atomically and preserves the active selection on conflict.
- Confluence finalization locks the matching connection generation before target projection. The workflow uses captured `spaces` rather than re-reading a later selection.
- No changed transaction remains open across native enqueue, provider API, Git, or model work. Recovery preview uses an explicit organization and at most 100 listed connection IDs; apply is opt-in and has no startup/migration hook.

## Proof disposition

- Inspected the committed evidence for 73 checkpoint tests, 69 binding/finalization tests, backend types with 138 acknowledged diagnostics, policy checks, and scoped Biome. Nothing was rerun.
- Native proof covers owner-first config admission for all three providers, failed/canceled enqueue boundaries through HTTP/webhook/PostgreSQL/OpenWorkflow, canceled-before-activation content ownership, terminal-before-capture projection, delayed completed acknowledgment, generation-fenced PR finalization, Confluence proposal contention, legacy replay, and explicit bounded recovery.
- The added tests use real HTTP/PostgreSQL/OpenWorkflow boundaries; no new `vi.mock`, owned-module replacement, or production logger mock was introduced.
- The legacy compatibility proofs use explicit `enabled`/phase fields, so they do not exercise the documented schema-default regression.

## Fowler baseline disposition

- New/expanded: **Mysterious Name** for the now-dual-purpose owner column; **Repeated Switches** for provider/storage dispatch; **Duplicated Code** between config and content admission.
- Remaining: **Duplicated Code** in GitHub credential issuance, conversation preparation/publication, and typed workspace admission.
- Suppressed: explicit provider workflow similarity because ADR-033 requires visible typed lifecycle steps; no generic StepApi-owning helper should replace them.
- No actionable Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, or Refused Bequest found.
- Declared open event ordering/capture checks, obsolete helpers, canonical extraction, unborn bootstrap, model allocation/kill bounds, Files/semantic lost acknowledgement, remaining duplication, and final write-path audit were not treated as surprise omissions.

## Counts

- Documented-standard violations: **1**
- Fowler heuristic smells: **6**
- Implemented-scope blockers: **1**
