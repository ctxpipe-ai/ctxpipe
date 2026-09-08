# Gate 3 all-connectors checkpoint — Spec coverage ledger

## Pin and contracts

- Reviewed exact `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...6bae4242686cc2438a3ac0fa326ca44e748f0b7d`, its 17-commit log, and full changed-file surface. All repository reads used target-qualified `git show`, `git grep`, or pinned diffs; the moving worktree was not used.
- Applied the repository code-review skill's Spec axis, root/backend `AGENTS.md`, source-connectors instructions, recovery-plan Gate 3 lines 642–659, ticket 10 lines 39–132, ADR-023, ADR-025, ADR-033, and pinned status/write-path audit.

## Prior config-identity finding and shared write path

- Traced `configBlobSha` from `captureConnectorMirrorTarget` into the strict connector command schema, durable job payload/equality, native mirror input, and semantic child schema/handoff. Capture obtains the actual Git blob object ID from the captured revision; absence is explicit `null`, including Slack's no-config contract.
- Traced binding and scope checks through acquisition, ordinary no-op refresh, tip-advance semantic capture/retry, prepared candidate validation, pre-credential broker admission, post-credential binding recheck, native fast-forward push, lost-ACK ancestry, publication, and hydration. The committed stale-config/deletion interleaving rejects the old command before semantic child creation and preserves the newer content. Prior P1 is resolved.
- Checked path confinement, config-file exclusion, duplicate operation rejection, immutable command replay, one job/result/commit ownership, paused acquisition/push loops, repository-scoped read/write credential split, non-fast-forward handoff, and no force push.

## Notion

- Traced full and entity callers into target capture, current Git config parse, fresh provider credential reload, capture-only transforms, typed `step.runWorkflow`, ingestion handoff, result shaping, and setup finalization.
- Durable target output contains sanitized binding data, workspace revision, native paths/config, provider workspace identity, and mirror identity; decrypted access/refresh tokens do not cross the provider step boundary. Token refresh writes occur in short org SQL calls rather than holding SQL over provider I/O.
- Full failure suppresses deletion; partial capture publishes successful files without orphan deletion. Entity failure retries before any child write. Existing setup/finalization races are explicitly tracked open.

## Confluence

- Traced full and space webhook parents through joined target lookup, immutable config/tree capture, fresh Forge installation reload, provider capture, typed child, sync-marker updates, result publication, and initial-setup projection.
- App system tokens remain inside target-check/provider capture steps and are absent from durable outputs and child commands. Cloud/base-URL identity is rechecked before provider access.
- Verified deletion calculation: any page failure yields no orphan deletion; a thrown space/page-list request prevents child admission; a space-mode full reconciliation filters both scope and managed paths to the requested space; single-page mode performs no global orphan pass. Config and unrelated roots are preserved.
- Failure/retry marker publication and binding-CAS finalization remain declared lifecycle work and were not counted as checkpoint defects.

## Slack

- Traced signed webhook admission/idempotency, thread-only refusal, target capture, working status, model intent, deterministic provider fetch, status-message exclusion, user/permalink resolution, 500-message cap, Markdown conversion, typed mirror child, GitHub link construction, and status update/fallback.
- The model tool mutates only an in-step `captureRequested` flag; it cannot fetch or write Git. Provider and Slack status operations reload the encrypted-token-backed connection inside their own steps. Durable workflow inputs/step outputs and mirror child inputs omit the token.
- Success and capability paths publish only after their durable work completes. Found that a rejected native child (or another thrown post-working step) bypasses the sole terminal publication step. The webhook has already acknowledged/enqueued and cannot cover this. The removed mock contract explicitly tested thrown-agent terminal status; the new native parameterization has no failed-child case.

## Evidence and exclusions

- Inspected the committed real PostgreSQL/OpenWorkflow/bare-Git connector proofs, stale-scope RED/green evidence, transient-token assertions, Confluence failure/deletion assertions, CI regression replacements, status claims, and the reduced 140-diagnostic type baseline. Heavy suites were not rerun.
- Excluded the audit's declared connector setup/finalization races, provider state retry lifecycle, export/extraction planning, empty-repository initialization, config-PR/conversation broker work, alternate credential/writer removal, provider topology, generic runner deletion, and Gates 4–6.
