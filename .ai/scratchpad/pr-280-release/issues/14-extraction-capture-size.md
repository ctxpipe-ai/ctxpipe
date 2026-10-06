# Extraction capture over 8 MiB fails ingestion and loses the paid extraction

Status: in-review
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-05
Updated: 2026-10-06

## Context

The ingestion validator (ticket 04) ran on the public `n8n-io/n8n` monorepo. Extraction ran for 56 minutes and made 545 model calls (about $0.65). Then the ingestion failed with `Extraction capture exceeds 8 MiB`. Nothing was committed to the Workspace, so all of the spend was lost. Each customer repository of that size fails the same way, so this ticket blocks the release.

Traces (HyperDX, `DeploymentEnvironment = ingestion-validator`): orchestrator `a233af717b2d7c891202cec658f9ecd7`, ingestion `68c9e4c0cfa68d626ce7df97b658fc2a`. The investigation had no HyperDX access, so the failure point below comes from the code.

## Cause

### Where the caps are

`extractionCaptureBudgetSchema` in `apps/backend/src/domain/workspaces/extraction.ts` allows at most 10,000 objects, 50,000 claims, and 8 MiB of JSON. The code applies it at four points:

| Point | Where | Inside a durable step |
| --- | --- | --- |
| a | End of `extract-kind:<root>` (`runExtractKindForRoot`) | yes |
| b | End of `identify:<root>` (`concatExtracted`, two times) | yes |
| c | Workflow body of `repository-ingestion`, over all roots so far, after each batch of two roots | no |
| d | `workspaceExtractionSchema`: the final command, again as the input schema of `workspace-write-extract-ingest`, and in the write-job intent and semantic-merge schemas | no |

### Why the caps exist

There is no recorded reason. The caps came in with #319 (`3f105fb3a`, a large refactor) without an ADR. The comment "Leave native step capacity for retries and publication" is on `extractionRootsSchema` (128 roots), not on the byte cap. It refers to the OpenWorkflow limit of 1,000 step attempts for each run (`WORKFLOW_STEP_LIMIT`): 128 roots × 2 steps × 3 attempts = 768.

No hard limit exists at 8 MiB, 10,000 objects, or 50,000 claims:

- OpenWorkflow 0.10.1 has no size limit on step output or workflow input. It keeps both in `jsonb` columns. On each replay it loads the output of every step attempt of the run (`listAllStepAttemptsForWorkflowRun`).
- The Postgres hard limit is 255 MiB for one `jsonb` value.
- The real limit is worker memory. The CDK worker has 1 GiB (small), 2 GiB (medium), or 4 GiB (large), and each worker runs two or more workflows at the same time. Today the pipeline keeps many copies of one capture: the per-root step outputs (the `extract-kind` output is copied again into the `identify` output), the cumulative arrays, the finalized arrays, the parsed command, the child workflow input, `workspace_write_jobs.payload`, the child replay, the rendered files in the `transform-extract-ingest` output, and the base64 Git packs in the `stage` and `commit` outputs.
- Measurement (Bun, synthetic capture): one parsed copy of a 120 MiB capture uses about 190 MiB RSS. Six to eight copies of a capture ten times the size of n8n do not fit a 1 GiB or 2 GiB worker.

### Which check failed for n8n

Check c, the cumulative check in the workflow body. This is an inference from the code:

- Zod reports only the byte message when the count checks pass. Thus the n8n capture had fewer than 10,000 objects and fewer than 50,000 claims, but more than 8 MiB of JSON.
- Checks a and b run inside a step. A failure there shows as a failed `identify:<root>` step attempt, retried three times, and each retry pays for the model calls of that root again.
- Check c runs before check d and on larger data (claims still carry their provenance).

To confirm: in the ingestion trace, the error is on the workflow run, and no `identify:*` step attempt failed.

### Why all of the spend was lost

Per-root extraction is durable only inside one workflow run (OpenWorkflow step outputs). A worker crash resumes the run and pays nothing again. But an error in the workflow body ends the run, because the default workflow retry policy is `maximumAttempts: 1`. The next ingestion is a new run, so it pays for every root again. Nothing reuses the stored step outputs of a failed run.

## Goal

A repository of n8n size, and up to about ten times that size (linux, kubernetes), ingests and publishes all of its extracted knowledge. A failure after extraction does not make the next attempt pay for the model calls again.

## Acceptance criteria

- [x] The `capture-over-8-mib` mode of `repository-extraction-native.contract.test.ts` passes: three recorded roots that hold more than 8 MiB together publish all 900 objects. (It fails on the current code with `Extraction capture exceeds 8 MiB`.)
- [x] No check stops a capture after the model calls because of its total size. A limit that remains comes from a real limit (memory or `jsonb`) and stops the work before the model calls, or it bounds one piece of a chunked publish.
- [x] After a failure that follows extraction, a new run for the same commit does not call the model for roots that were already stored (option D).
- [ ] Peak worker memory for a synthetic capture ten times the size of n8n stays inside the small CDK worker (option C). Not in this build: the user chose B + D. Follow-up if ten times n8n comes into scope.
- [x] ADR-047 (or a new ADR) records where captures are stored and how a large capture is published.

## Plan

Options, with their cost. The line counts include tests.

| Option | What changes | Size | n8n | 10 × n8n |
| --- | --- | --- | --- | --- |
| A. Raise or remove the caps | Change the numbers in `extractionCaptureBudgetSchema` | ~20 lines | yes | no: six to eight copies do not fit a 1–2 GiB worker; the child input and the write-job payload come near the 255 MiB `jsonb` limit at about twenty times |
| B. Capture by reference, one publish | New table `repository_extraction_captures` (run, root, part of at most 4 MiB). `identify:<root>` writes its rows and returns only counts. The child workflow input and the write-job payload carry a reference, not the capture. The child transform reads the rows. | ~350 lines and a migration | yes | partly: removes the `jsonb` limit and about five copies, but one in-memory plan over the whole capture remains, and the `transform`, `stage`, and `commit` outputs still grow with it; about 3–5 × on a medium or large worker |
| C. B plus a chunked publish | Pass 1 writes objects in bounded chunks and keeps their paths. Pass 2 writes claims grouped by subject in bounded chunks, with retraction limited to the subject files of the chunk. Pass 3 is one retraction sweep over the files of this repository that no chunk wrote. One commit for each chunk; a failure resumes at the next chunk; one hydrate at the end. Also removes the O(claims × objects) `assigned.find` in `planKnowledgeProjection`. | ~900–1,200 lines | yes | yes |
| D. Reuse paid roots across runs | Key the rows of B by repository, target commit, root, and extractor version. A new run for the same commit reads the stored roots and does not call the model. | ~200 lines on top of B | — | — (makes any later failure cheap) |

Rejected without a user decision: A, because the memory limit that the caps protect is real. A one-commit-per-root-batch publish with `partial` retraction over the batch roots is also rejected: a root `.` overlaps all paths, references across batches are lost on a first ingest, and `finalizeExtractedReferences` and `linkPackageHierarchy` need all roots.

Recommendation: C, built in slices. Slice 1 is B, which turns the red test green for n8n-size captures. Slice 2 is D. Slice 3 is the chunked publish. If ten times n8n is out of scope for this release, ship B and D only.

Small fixes that apply to every option: remove the duplicate cumulative check c; do not copy the `extract-kind` output into the `identify` output.

## Open questions

- Is ten times n8n (linux, kubernetes) in scope for this release, or only n8n size? This decides between B + D and C.
- Is several commits for one large ingest acceptable in the Workspace history (option C)?

## Delegation brief

Read `domain/workspaces/extraction.ts`, `graphs/codeIngestionGraph/runExtractRoot.ts`, the extraction part of `openworkflow/workflows/repository-ingestion.ts`, `openworkflow/workflows/workspace-extract-ingest.ts`, `domain/workspaces/plan-extraction.ts`, `retract-extraction.ts`, `migration-export.ts` (`planKnowledgeProjection`), and ADR-047. Start from the red mode `capture-over-8-mib` in `openworkflow/workflows/repository-extraction-native.contract.test.ts`. Run it with a per-worktree database. Keep the per-root step boundaries (lessons: durability lives in OpenWorkflow steps).

## Comments

- 2026-10-05 (claude): investigation done, red test written. Stopped before the build, as the brief asks for a stop before more than about 400 lines. Waiting for the user to choose an option.
- 2026-10-05 (user): build B + D, with the small fixes.
- 2026-10-06 (claude): B + D built. See Resolution.

## Resolution

Built options B and D, with the small fixes.

**Storage by reference (B).** The new table `repository_extraction_captures` holds the paid extractor output of each root, in one row. One root cannot come near the 255 MiB `jsonb` limit, because its `extract-kind` output already fits in one OpenWorkflow `jsonb` value. `identify:<root>` writes the row of its root and returns only the counts. The loader parses each row with the extractor schemas, so a bad row fails with a clear error. The extraction command (`WorkspaceExtraction`) now has the source header and a `capture` key (scope, extractor version, roots), not objects and claims. Thus the child workflow input, the write-job payload, and the semantic-merge input stay small. The `transform-extract-ingest` step reads the rows, resolves references (`finalizeExtractedReferences`), and adds the package hierarchy. These steps ran before in the workflow body on each replay; now they run once in a durable step. A root without rows stops the publication with an error, so a partial capture never causes a full retraction.

**Reuse (D).** The key is repository, target commit, scope (`full`, or `since:<base>` for a partial ingest), `EXTRACTOR_VERSION`, and root. The scope is in the key because a partial capture holds only the changed paths: a full run must not reuse it. When the root is stored, `extract-kind:<root>` and `identify:<root>` make no model calls. Increase `EXTRACTOR_VERSION` when an extractor changes its output. The row records the number of files that `extractInstructionUnits` skipped after a model error. Only a root with zero skipped files is reused, so the skipped files get a second try. When a run has skipped files, its extraction command carries no retraction, so the write job expires no evidence of those files. A full re-index (`fullReingest`) deletes the rows of its key first and reuses no root. When the stored capture does not parse or does not plan in the write job, the job deletes the rows of that key, so the next run extracts again. A push or lock error keeps the rows.

**Retention.** After the publication succeeds, the parent deletes all rows of the repository: each source commit and scope, also the rows of failed runs that nobody retried. Ingestion runs one at a time per repository (`repository_ingestion_requests`), so no run that can still publish needs those rows. The foreign key to `repositories` deletes the rows with their repository. A first review had a seven-day age sweep in each store; it was removed, because it could delete a root that a live run still needed.

**Caps.** Removed `extractionCaptureBudgetSchema` at all four points (a, b, c, d) and the admission test for it. The command still limits a partial retraction to 100,000 paths. The workflow checks this count before the model calls; when a change set is larger, it extracts and retracts the full repository, because such a change set is near a full rewrite and a rejection would block the repository on each run. The caps only protected payload size, and B removes the large payloads. The 128-root cap stays: it protects the OpenWorkflow step limit, and it fails before the per-root model calls. The `identify` output no longer copies the `extract-kind` output.

**Publication speed.** `stageGitFiles` ran two Git processes for each file. 900 files took more than 150 s. It now writes all blobs with one `hash-object --stdin-paths` and one `update-index --index-info` (about 16 s for the whole contract mode).

**Proof.**
- `capture-over-8-mib` passes (red before: `Extraction capture exceeds 8 MiB`).
- `repository-producer-native.contract.test.ts`: the remote refuses the push, so a first run and then a full re-index fail after extraction, and each one calls the extractors. The last run for the same commit makes 0 extractor model calls (msw count); before D it made 9. The test also checks that no capture rows remain after success.
- `repository-extraction-captures.integration.test.ts`: no reuse across scope (`full` and partial, in both directions) or extractor version, no reuse of a root with skipped files, no age sweep, the delete of one key and of the repository, the publish delete that keeps the rows of a newer run, and a clear error for a bad row.
- `write-extract-native.contract.test.ts`: a stored capture that does not parse is deleted by the write job.
- `extraction.test.ts`: the partial-retraction path limit and the retraction with skipped files.
- The extraction, write, retraction, export, and owner contract tests pass.

**Open points.**
- Option C (memory for ten times n8n) is not built. One in-memory plan over the whole capture remains, and the `transform`, `stage`, and `commit` step outputs still grow with the capture. `nativeGit` has a 64 MiB output buffer and a 60 s timeout, which a very large publication can reach.
- An in-flight run from before this deploy has old `identify` step outputs (objects and claims, not counts) and no rows. Its counts are wrong, and its publication fails with "Extraction capture is missing for root". A queued write job from before this deploy has objects and claims in its input, and the strict input schema rejects it. In both cases the next run extracts again and pays again once.
- An in-flight run from before this deploy can have a memoized `extract-kind` output of `null`. `runIdentifyPhaseForRoot` then fails with a `TypeError` at `"reused" in kindPartial`. The run fails, and the next run extracts again and pays again once.
- After a publish, a run deletes only the rows of its own key and the rows stored before the run started. Thus a run that waits for write access does not delete the roots that a newer run (a new target branch) stores. One small window remains: when a newer run reuses a root of its own key that was stored before the publishing run started, the publish deletes that row. The newer run fails with a missing root, and the next run extracts again.

