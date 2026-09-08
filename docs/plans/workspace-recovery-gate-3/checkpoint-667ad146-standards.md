# Standards review — `667ad146d4533f82488e2aac7d232ad9b416e52a`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...667ad146d4533f82488e2aac7d232ad9b416e52a`
**Result:** 0 documented violations; 8 Fowler heuristic smells; 0 implemented-scope blockers.

## Documented standards

No violation found in the implemented increment. The Confluence mismatch is fixed by routing both persisted and requested selections through `confluenceSpaceSelection` (`apps/backend/src/models/atlassian-connector.ts:888-902`), with native null/empty replay coverage.

The extraction path follows ADR-033: the producer captures a destination revision before extraction (`domain/workspaces/capture-repository-extraction.ts:15-60`; `workflows/repository-ingestion.ts:163-172`), normalizes duplicate observations before persisting the child input (`domain/workspaces/extraction.ts:39-58`), and awaits the typed native child before marking indexing ready (`repository-ingestion.ts:446-524`). The pure adapter reads only the captured batch, acquired Git tree, and compact path identity (`domain/workspaces/plan-extraction.ts:14-81`; `workspace-extract-ingest.ts:96-150`). No credential is durable and no SQL transaction spans Git, model, or workflow I/O, satisfying ADR-027/028 and backend `AGENTS.md:11`. The native restart test runs PostgreSQL, Git, OpenWorkflow, producer, and writer rather than mocking owned collaborators (`repository-extraction-native.contract.test.ts:12-203`), satisfying TDD `mocking.md:3-13`.

Declared retraction, endpoint, declaration-fence, bounds, producer admission/recovery, and earlier audit work was excluded.

## Fowler heuristics (judgment calls)

- **Speculative Generality:** the deleted DB/graph pipeline leaves unused ingestion channels (`objectIds`, `touchedObjectIds`, `claimsForProjection`), an unused `runExtractForRoot`, and retrieval-object write APIs with test-only callers (`codeIngestionGraph/schemas.ts:114-136`; `runExtractRoot.ts:88-103`; `retrievalObjectWrite.ts:60-270`). Remove these remnants or move legacy fixture seeding to test support.
- **Mysterious Name:** durable `sourceId` is converted to `evidenceKey` (`extraction.ts:29`; `plan-extraction.ts:74`).
- Remaining cumulative judgments: dual-purpose `contentSyncWorkflowRunId` (**Mysterious Name**), provider dispatch (**Repeated Switches**), and four **Duplicated Code** shapes: connector admission, GitHub credential issuance, conversation preparation/publication, and typed workspace admission.
