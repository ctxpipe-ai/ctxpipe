# Gate 3 checkpoint c869ba82 — Spec coverage ledger

## Boundary and sources

- Verified base/head, the 30-commit log, and cumulative three-dot diff (1,678 files). Current reads used `git show c869ba82...:path`; prior reviewed slices remain covered by their checkpoint ledgers.
- Applied root/backend `AGENTS.md`, the code-review skill, recovery plan Gate 3 (`workspace-chat-recovery.md:642-659`), locked tickets 02/03/10/18, ADR-033, pinned status, and write-path audit.
- Read-only review: no implementation edits, workflow/test execution, or delegation.

## Retraction capture and ownership

- Traced `retraction` and `sourcePath` from repository index results through `repository-ingestion.ts:457-507`, strict extraction schema/budget, immutable job intent, replay equality, extraction workflow, broker source-declaration checks, and semantic-child handoff. Full/partial mode, observed index time, changed/deleted/rename paths, and the captured source declaration survive retries and races.
- Rechecked source authority at acquisition, no-op refresh, push, credential-delay recheck, and semantic refresh. A changed/unlinked declaration fails before a new publication.
- Inspected `retract-extraction.ts` behavior for future `valid_from`, already-expired evidence, reassertion, unrelated repositories, absent/unidentifiable source, relative own-repository sources, absolute linked sources, malformed YAML, aliases, owner fields, and body preservation.
- Confirmed owner-selected assigned paths can now be written while root `AGENTS.md`, `.agents/**`, flat repository declarations, and Linear/Notion/Confluence/Slack trees are excluded.

## Findings traced through shared projection

- Followed claim conversion into `planKnowledgeProjection`, `mergeImportedClaims`, `mergeExistingImportedMarkdown`, and the later retraction pass. Both merge layers use only `(to,predicate)`, so source-distinct temporal signals are corrupted before the new source-keyed assertion set sees them. Reported P1.
- Compared producer provenance shapes. `extractKind` supplies `configPath`; dependency capture supplies `consumerPath`; API extraction supplies directory-valued `path`; several extractors expose only `root`. The current string-only source path and one-way partial matcher cannot retract a removed API endpoint after a descendant route-file change. Reported P1.

## Root and output bounds

- Verified `extractionRootsSchema` caps 128 roots and 4096 characters, is applied inside current root detection, again after cached `identify-roots` output, and therefore rejects historical 129-root results before fan-out.
- Verified two-root batches, per-root 8 MiB/10,000-object/50,000-claim checks, and cumulative validation after every batch. This closes the prior c869 predecessor finding; concurrency is now a constant bound.
- Inspected pinned red/green evidence and assertions but did not rerun it.

## Scope classification

- Findings: **2 P1, 0 P2, 0 P3**.
- Kept as declared open scope rather than findings: complete source-to-destination endpoint mapping, native repository-ingestion owner/admission/terminal recovery, live extractor proof, remaining source ordering, and the broader Gate 3 audit.
- No separate defect found in immutable retraction persistence, source-declaration fencing, semantic handoff, root caps, owner-path publication, Slack exclusion, or no-op/replay behavior.
