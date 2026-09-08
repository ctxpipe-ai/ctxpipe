# Gate 3 retraction checkpoint — Standards coverage

## Review identity

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Pinned head: `c869ba820ad722a3c5936568a69d02baa1546bb9`
- The merge base equals the fixed base. The cumulative range has 29 commits and 1,678 changed paths. The increment after `716a0a80a2679b74fb9a3dc1f18c57c93d3573a2` has 42 paths: 7 production, 2 test, 26 evidence, and 7 documentation/review paths.
- Inspected only `git diff BASE...PIN`, `git log BASE..PIN`, and `git show PIN:path`. No worktree content, code edits, or test execution were used.

## Standards applied

- Pinned root `AGENTS.md` and `apps/backend/AGENTS.md`.
- Pinned `.cursor/skills/code-review/SKILL.md`, `.cursor/skills/tdd/SKILL.md`, and `tdd/mocking.md`.
- Source-connectors guidance, ADR-027, ADR-028, ADR-033, the accepted ingest/write protocol, and current Gate 3 status/audit.
- Complete supplied Fowler baseline, with repo rules taking precedence and tooling-enforced matters excluded.

## Increment surface and callers

- `domain/workspaces/extraction.ts`: checked root count/string bounds, aggregate object/claim/byte budget, immutable full/partial retraction scope, observation time, source-path capture, and all schema consumers. `retraction` and `sourcePath` flow through the existing extraction payload, job intent, write owner, broker, and semantic handoff because those persist/compare the complete extraction value.
- `graphs/codeIngestionGraph/nodes/identifyRoots.ts` and `runExtractRoot.ts`: traced deterministic, ambiguous/model, partial narrowing, per-kind, and combined-identify outputs. Root capture is parsed inside the durable callback and again before fan-out; each root result and each cumulative two-root batch is budgeted.
- `openworkflow/workflows/repository-ingestion.ts`: inspected source time selection, partial changed/deleted/rename scope, provenance adaptation, two-root batching, final aggregate parsing, native child invocation, and success/follow-up order. No DB transaction spans Git, provider, or model work.
- `domain/workspaces/plan-extraction.ts` and new `retract-extraction.ts`: traced reference identities, planned-file overlay, assertion indexing, full/partial selection, `valid_from` ordering, expiry/reassertion, alias materialization, and owner-file output into `workspace-extract-ingest` staging. Control paths (`AGENTS.md`, `.agents/**`, repository declarations) and connector roots are excluded at publication.
- `layout.ts` and `workspace-extract-ingest.ts`: verified Slack joins the connector exclusion and canonical knowledge outside `knowledge/**` can be updated while control/connector content remains protected.
- Native tests: reviewed full and partial expiry, unrelated repository/source-less preservation, owner prose/metadata, expired-claim reassertion, source restart/unlink/edit, 129-root historical replay rejection, and no-write assertions. Ordinary `src/billing.ts` is covered; no accepted path containing `#` exercises the source serialization/parser mismatch reported above.
- Evidence/status/ADR: checked red/green provenance, final 13-case regression and reported 138 unchanged type allowances without rerunning them. The prior root-bound finding is structurally corrected. Declared endpoint, producer terminal ownership, source ordering, and older audit work was treated as open acceptance inventory.

## Cumulative interface and Fowler audit

Rechecked cumulative database migrations/schema, Git pack/write helpers, revision/binding readers, write command/job persistence, admission/broker/semantic handoff, all typed workflows, connector parents/finalization, repository extraction, conversation publication/API/UI capability, legacy recovery, and their callers/proofs. One documented violation is above. Seven earlier Fowler judgments remain; Speculative Generality stays closed, and Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Message Chains, Middle Man, and Refused Bequest produced no additional actionable finding for this increment.
