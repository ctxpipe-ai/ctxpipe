# Gate 3 activation-owner checkpoint — Spec coverage ledger

## Pin and governing sources

- Reviewed exact three-dot range `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...e94731f310ff539fe86bb5499e6c691256e48b41` and enumerated its commits. All repository content was read from the pinned commit with `git show`/`git grep`; mutable worktree content was excluded.
- Applied `.cursor/skills/code-review/SKILL.md` on the Spec axis, root and backend `AGENTS.md`, `docs/plans/workspace-chat-recovery.md` Gate 3 lines 642–659, locked ticket 10 lines 39–48, 54–64, 68–82, 96–132, and ADR-033 lines 7–26.
- Read pinned `docs/plans/workspace-recovery-gate-3/status.md` and `write-path-audit.md`; treated their open inventory as declared work rather than checkpoint regressions.

## Prior findings rechecked

- **Restored/rebased publication:** traced `conversation-publish.ts` capture, remote default/session reads, ancestor selection, thin-pack production, broker import, lease and binding checks. A rewritten shallow session can use the locally present session tip or captured default as the pack exclusion while retaining the observed remote session ref as the publication lease.
- **PR identity/read race:** traced generated nullable `lastChatPrRevision`, `conversationFieldsWithCurrentPr`, API schema projection, GET provider lookup, expected conversation branch, and the post-provider reread of saved number plus `sameWorkspaceBinding`. Relink/provider latency cannot return the previous PR.
- **Directory stale-row race:** traced all finalizer call sites and `upsertConnectionDirectory`. Successful connector finalizers no longer perform redundant directory writes. The shared function ignores its caller's stale config, locks/rereads the current connection, and updates the un-RLS directory in the same short transaction.

## Activation generation and finalization

- Inspected the generated migration/snapshot and Drizzle field for non-null generation 0.
- Traced Notion and Linear activation/retry mutations and Confluence target activation: setup transition and counter increment are atomic. Traced HTTP, GitHub webhook, and enqueue helpers through counter read, generation-scoped idempotency key, native enqueue, wake, and admission-failure reconciliation.
- Traced the three typed content schemas, capture steps, provider fetches, native mirror children, ingestion, Confluence synced-space markers, and final setup projection. `captureConnectorMirrorTarget` compares the requested counter; `lockConnectorFinalizationBinding` compares counter, repository, workspace generation/URL/connection/default, and provider workspace/cloud identity under a row lock.
- Checked all production `linearSyncContent.spec`, `notionSyncContent.spec`, and `confluenceSyncContent.spec` callers. Route/webhook/enqueue paths pass the generation. The Linear and Notion config no-change paths are the two omissions recorded in finding 1. The declared Confluence direct-live no-change lifecycle was not reported as a new defect.
- Traced durable-upgrade behavior across old workflow input, cached capture output, the generation-0 SQL migration, strict schemas/finalizer binding, and `input->>'contentSyncGeneration' = '0'`; recorded finding 2.

## Terminal-owner projection and reads

- Traced `reconcileConnectorContentSync` from Notion, Linear and Confluence binding/status readers and every admission catch. It row-locks the connection, ignores pending/running owners, and projects only failed/canceled current-generation owners or a proven ownerless failed admission.
- Compared this lookup with success finalization and all connector identity writers. The owner row contains no captured repository/provider binding, while Forge lifecycle upsert can mutate cloud/base identity on the same connection without incrementing generation; recorded finding 3. Existing native contracts cover changed identity for success finalization and changed generation for terminal owners, but not terminal owner plus same-generation provider replacement.

## Evidence reviewed, not rerun

- Inspected pinned status claims and saved logs for 106 affected tests, fresh/upgrade migrations, backend types with 138 acknowledged diagnostics, 440/27 proof-policy checks, and scoped Biome. Per instruction, no test process was started.

## Declared open scope excluded from findings

Activation/admission crash interval; duplicate/out-of-order config events; Confluence config no-change direct-live flow; canonical extraction sources; unborn bootstrap; remaining admission/planner/credential duplication; other `write-path-audit.md` inventory; Gates 4–6.
