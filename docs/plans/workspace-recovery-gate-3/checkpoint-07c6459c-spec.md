# Spec review — Gate 3 eleven-kind checkpoint

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...07c6459cc260a5be65183ab3cc1d485815d0fb5b`.

## Findings

1. **[P1] Post-cutover extract loses file identity and can create duplicates on an unchanged rerun.** `workspace-extract-ingest.ts:95-109` disables `import_key` after a completed export. `migration-export.ts:469-479,516-539,601-629,717-725` can then recover an object only at its newly preferred path. An exported object already at `knowledge/imported/**`, at a collision suffix, or the second of two same-slug objects loses its key on the first extract; the next identical job allocates/merges a different path (and successive collisions advance `-2`, `-3`, …). Ticket 12:76 requires a stable identity “so re-runs and merges can find the same fact”; ticket 10:77 says “No file changes → skip.” Carry the extractor's immutable object-to-path/file command through the workflow (or retain a separate durable mapping) and add non-preferred and same-slug two-run proofs.

2. **[P1] Paused connector commands discard their source binding.** `enqueue-workspace-write-commit.ts:329-341` calls `writeJobIntentPayload` without `mirror`, although that helper supports it (`write-job-intent.ts:98-117`). `enqueueInputFromPausedJob` can therefore reconstruct no mirror (`:155-195`); the tip-check claims the row queued, typed admission rejects it, and it remains an unusable command. Ticket 10:130 requires destination-only mirrors to “pause … [and] resume … when writable.” Parse the typed mirror command before any status branch, persist `mirror: input.mirror`, and prove the paused row retains all file/delete/source fields. Full pause/resume completion can remain in the declared follow-up.

All five prior Spec findings and the alias-comment Standards finding are corrected in the pinned blobs. One-commit/no-op/replay, binary bytes, config/path limits, binding checks around credential issuance, native non-FF behavior, descendant push recovery, publication, and hydrate-before-completion otherwise trace correctly.

The declared semantic merge, planner/caps/follow-ups, complete pause/conflict handling, provider caller migration, alternate writer/credential removal, and generic runner deletion remain open; this is not Gate 3 acceptance.
