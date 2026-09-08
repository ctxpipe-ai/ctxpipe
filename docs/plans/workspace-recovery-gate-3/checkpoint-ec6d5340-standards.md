# Gate 3 ec6 checkpoint — Standards review

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...ec6d5340c4db91c4e888540deedddaa891ad9f58`

## Documented-standard violation (1)

**[P1] Connector recovery bypasses the new workflow-version guard.** `runWorkflowWithWorkerWake` correctly rejects a returned handle whose name/version differs from the requested spec (`apps/backend/src/openworkflow/client.ts:14-27`). Both connector enqueue paths catch that rejection, however, call `findConnectorSyncOwner`, and activate whatever ID it returns (`enqueue-connector-config-sync.ts:69-105`; `enqueue-connector-content-sync.ts:41-81`). That lookup filters workflow name/input/key but omits `namespace_id` and `version` (`models/connector-content-sync.ts:335-349`); `activateConnectorSync` also omits both (`:199-232`). A same-name/key prior version therefore triggers the guard, is immediately recovered, and becomes the durable config/content owner. This violates ADR-033:25,33: connector state belongs to its generation-scoped native owner, and uncertain admission may recover only the accepted owner. Require the requested name, version and namespace throughout connector lookup/activation, and add the same native wrong-version collision used for workspace admission.

The previous workspace-owner blocker is closed: recovery derives the exact workflow name from immutable kind and requires null version in both ID/key branches (`workspace-write-jobs.ts:569-583`); native wrong-name and wrong-version cases cover pre-claim recovery (`workspace-admission-ack-native.contract.test.ts:154-240`).

Claims-only projection now mutates YAML while retaining the original body byte slice (`migration-export.ts:91-157,659-678`), and root evidence canonicalizes URL/relative dot roots to one empty-root identity while rejecting escapes (`retract-extraction.ts:13-56`). The three config workflows retain the captured binding across replay, compare reloaded repository/branch, and recheck the full current binding before synchronization; their restart cases exercise all providers.

## Fowler heuristic judgments (9; non-blocking)

The cumulative ledger remains **Mysterious Name (2)** (`sourceId`/`evidenceKey`; `contentSyncWorkflowRunId`), **Repeated Switches (1)** in connector lifecycle dispatch, and **Duplicated Code (6)** across typed-write admission, connector admission, GitHub credential issuance, conversation preparation/publication, captured-source JWT assembly, and backend/codesearch published-checkout SQL. This increment closes none.

**Blockers: 1.**
