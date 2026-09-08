# Gate 3 durable-setup checkpoint — Spec coverage ledger

## Pin and governing contracts

- Reviewed exact `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...4a603c1992a0c69ce06efbb70e3e5b55d12c3a73`; enumerated all commits and isolated the `e94731f3...4a603c19` increment. Every repository read used `git show`, `git grep`, or a pinned diff; moving worktree content was excluded.
- Applied the Spec axis from `.cursor/skills/code-review/SKILL.md`, pinned root/backend `AGENTS.md`, recovery-plan Gate 3 lines 642–659, ticket 10 lines 39–48, 54–64, 68–82, 96–132, ticket 14 publication/lease rules, and ADR-033 lines 7–26.
- Read pinned `status.md` and `write-path-audit.md`. Config-proposal claim/enqueue crash and acknowledgement handling, remaining event ordering/legacy helpers, canonical extraction, unborn bootstrap, semantic handoff uncertainty, model/allocation kill proof, duplicated admission/planner/credential paths, and other audit inventory were treated as declared open scope.

## Prior e947 findings

- **No-change admission:** traced Linear, Notion, and Confluence config workflows through binding capture, provider config publication, changed/no-change branch, shared content admission, first activation, provider capture, native mirror, ingestion, and finalization. All three no-change branches now pass provider/repository/branch and a stable config-workflow key to the shared owner-first helper; Confluence's direct `live` helper was removed.
- **Generation-zero compatibility:** all three content and config schemas default absent generation to zero. Activation and binding assertions normalize absent input values; finalization falls back from cached capture generation to input/zero; reconciliation SQL coalesces missing JSON generation to zero. Native compatibility tests cover legacy content owners/captures and prevent legacy draft activation.
- **Terminal provider identity:** new content inputs persist provider, repository, branch, workspace/cloud/base identity. Activation, pre-provider capture, and terminal projection compare it. Forge cloud/API-base replacement advances generation, so the old legacy owner cannot project onto the replacement.

## Content owner-first admission

- Traced `prepareConnectorContentSync`: current enabled/installed target validation, retry eligibility, same-config/current-owner reuse, and next-generation reservation.
- Traced `enqueueConnectorContentSync`: generation/config scoped idempotency, typed workflow selection and required org slug, uncertain enqueue recovery by native key, and activation call.
- Traced `activateConnectorContentSync` under the connection row lock: native run identity/type/org/connection, persisted binding, terminal-state rejection, generation CAS, owner ID publication, phase transition, and legacy zero eligibility.
- Traced each content workflow's first durable activation step, superseded return, binding assertion before external provider capture, immutable Git capture, typed native mirror child, post-write ingestion and fully fenced setup finalizer.
- Traced status reconciliation from all Linear/Notion/Confluence binding readers and admission catches. Current owner ID, generation, and persisted binding fence terminal content projection. The pre-activation terminal run remains next-generation and is therefore invisible to this query; paired with ignored activation failure and stable idempotency, this produced finding 2.
- Checked all production content callers: Linear/Notion retry HTTP routes, Linear GitHub push, Notion/Confluence push enqueuers, and the three config no-change tails use the shared helper. Retired claim-first content helpers have no production callers.

## Durable config workflows and compatibility

- Traced config proposal/save/retry callers into generated inputs and the three typed config workflows. Inputs contain only non-secret scopes/resources/binding generation; credentials are acquired inside durable provider steps.
- Traced first binding capture, target load, config publication, changed-result projection, Linear orphan-PR close on binding loss, and no-change child admission. Status reads locate failed/canceled config owners by generation plus completed captured-binding step and project only a matching pending configuration target.
- Compared the new step graph with e947 workflow definitions. Notion previously persisted `initial_sync` in a durable step before child admission; Linear had the same durable database side effect within its workflow. The new first capture cannot resume either post-transition state. The removed Confluence path had already completed by marking no-change targets `live`; no migration or owner backfill selects these rows. This produced finding 1.
- Inspected duplicate and A–B–A contracts, same-owner replay, stale/disabled config, terminal failure projection, and generated nullable owner-column fresh/upgrade migration. Remaining target-table/config-event interleavings match the explicitly open event-ordering inventory and were not findings.

## Earlier implemented interfaces

- Rechecked conversation thin-pack base selection and remote-session lease, revision-bound PR serialization/provider reread, connection-directory lock/reread, connector finalization identity locks, no-op content and semantic/native mirror boundaries. No regression found in those pinned surfaces.

## Evidence reviewed, not rerun

- Inspected recorded 113 tests across 13 suites plus seven compatibility cases, backend types at 138 acknowledged diagnostics, fresh/upgrade migration logs, proof policy, and scoped Biome. CI `34266720573` was running at the pin. Per instruction, no native or host suite was started.
