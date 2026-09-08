# Spec review — G3-C empty repositories (`ce00e052`)

## Finding

**[P1] The first real commit bypasses the required LLM-generated subject.** In `apps/backend/src/openworkflow/workflows/workspace-bootstrap.ts:142-149`, the unborn path commits with the unconditional literal `ctxpipe - Bootstrap workspace`. The locked protocol says: “Subject: **LLM-generated** on every commit (including mechanical syncs)… On timeout/garbage: **template fallback**” (`.ai/scratchpad/git-backed-projects/issues/10-ingest-to-git-write-protocol.md:72-77`). The ordinary initialized-bootstrap path correctly runs `generateCommitSubject` in its own durable step (`workspace-bootstrap.ts:338-349`), but every successful empty-repository root skips that step and uses what should only be a fallback. Generate and durably record the root subject before `commit-unborn`, using the repository name and allowed file names, and retain the literal only through the existing timeout/garbage fallback. Add a native assertion for both model output and fallback.

No other G3-C blocker found. The pinned implementation uses an immutable unborn binding with no fabricated SHA, performs a non-force actual-default push through the credential broker, adopts a competing human root into the same job before the normal transform, publishes/hydrates only a real canonical revision, and replays an uncertain first push by ancestry. Empty hydration returns without marking failure, and create/relink enqueue bootstrap independently.

Pending G3-D–G work was excluded as requested. This is a milestone review, not Gate 3 acceptance.
