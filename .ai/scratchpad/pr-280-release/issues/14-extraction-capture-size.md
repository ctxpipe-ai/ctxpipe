# Extraction capture over 8 MiB fails ingestion and loses the paid extraction

Status: plan-review
Priority: P0
Owner: claude
Blocked by: none
Created: 2026-10-05
Updated: 2026-10-05

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

- [ ] The `capture-over-8-mib` mode of `repository-extraction-native.contract.test.ts` passes: three recorded roots that hold more than 8 MiB together publish all 900 objects. (It fails on the current code with `Extraction capture exceeds 8 MiB`.)
- [ ] No check stops a capture after the model calls because of its total size. A limit that remains comes from a real limit (memory or `jsonb`) and stops the work before the model calls, or it bounds one piece of a chunked publish.
- [ ] After a failure that follows extraction, a new run for the same commit does not call the model for roots that were already stored (option D).
- [ ] Peak worker memory for a synthetic capture ten times the size of n8n stays inside the small CDK worker (option C).
- [ ] ADR-047 (or a new ADR) records where captures are stored and how a large capture is published.

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

## Resolution
