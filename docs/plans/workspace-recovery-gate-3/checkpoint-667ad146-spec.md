# Gate 3 pinned Spec review — `667ad146d4533f82488e2aac7d232ad9b416e52a`

Range reviewed: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...667ad146d4533f82488e2aac7d232ad9b416e52a`, using pinned blobs only.

## Findings

**No implemented-scope Spec defects found.**

The initially reported undefined-payload P1 is withdrawn. Although retained extractors construct payload objects with optional properties present as `undefined`, every kind and identify result reaches the aggregation through `step.run` (`repository-ingestion.ts:346-440`). OpenWorkflow 0.8 executes the callback, persists `normalizeStepOutput(result)` with `completeStepAttempt`, and returns `savedAttempt.output` even on the first execution (`openworkflow/dist/worker/execution.js:431-445`). The PostgreSQL backend stores that output through `pg.json` and returns the JSONB row (`dist/postgres/backend.js:669-693`). Consequently object properties whose value is `undefined` are absent before `workspaceExtractionSchema.parse` at `repository-ingestion.ts:448`; there is no native route carrying the raw callback object to that parse.

The prior duplicate-key P1 is closed: `workspaceExtractionSchema` merges repeated observations in encounter order using the extracted pure legacy merge (`extraction.ts:38-58`; `extraction-payload.ts:1-16`). The repository parent now awaits one stable native child, and direct ingestion calls to object/claim DB writes, Falkor projection, and embedding are removed. Existing Git-path, serving-ID, workspace-repository, and linked-declaration reference resolution is wired through `planCapturedExtraction`.

No tests were run, as requested. Retraction, complete endpoint mapping, declaration/rebind fences, bounds, and producer admission/terminal recovery remain declared acceptance scope, not checkpoint findings.
