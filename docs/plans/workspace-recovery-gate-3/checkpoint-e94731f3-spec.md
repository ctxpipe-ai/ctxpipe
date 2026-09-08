# Gate 3 activation-owner checkpoint — Spec review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...e94731f310ff539fe86bb5499e6c691256e48b41`
**Decision:** fail for implemented scope — 3 high-priority findings.

## Findings

**[P1] No-change Linear/Notion config workflows cannot start content sync — `apps/backend/src/openworkflow/workflows/linear-sync-config.ts:121-124`, `notion-sync-config.ts:80-89`.** Both invoke the newly strict content schemas without `contentSyncGeneration` (`linear-sync-content.ts:26-30`; `notion-sync-content.ts:22-28`). A config PR that computes no change therefore enters `initial_sync`, fails schema admission, then projects `sync_failed`/`config_failed`. ADR-033:25 requires **“full-content inputs … carry that counter”** and **“Admission uses a generation-scoped native idempotency key.”** Read the counter after the state transition and use the same generation-keyed admission/reconciliation helper as other callers.

**[P1] The generation fence is not deploy-safe for existing durable owners — `linear-sync-content.ts:26-30`, `notion-sync-content.ts:22-28`, `confluence-sync-content.ts:23-29`, `models/connector-content-sync.ts:41-47`.** The migration defaults existing connections to generation 0, but prior persisted workflow inputs and cached capture-step results lack the now-required field. New workers reject those inputs; reconciliation’s exact JSON predicate also cannot find a missing value, and an old cached binding finalizes with `undefined !== 0`. This can strand upgraded connections in `initial_sync`. ADR-033:11 says **“OpenWorkflow owns execution and retry,”** while line 25 requires current failed/canceled owners to project setup failure. Treat absent persisted generations as legacy 0 at schema, capture, finalization, and owner-query boundaries; prove worker restart across migration.

**[P1] Terminal failure can cross provider bindings — `models/connector-content-sync.ts:38-72`.** Reconciliation identifies an owner only by provider type, connection ID, and generation. Yet `models/atlassian-connector.ts:512-586` can replace that connection’s cloud ID/API base without advancing the counter. If the old cloud’s generation-N run later fails while the replacement target is `initial_sync`, a status read marks the replacement `sync_failed`. This is weaker than the full identity check used for success. ADR-033:25 requires that **“an old result cannot mark a different target live”** and **“A failed older owner cannot change a newer activation.”** Advance generation for every target-identity change or persist and compare the full captured binding before terminal projection.

## Verified

The three 5136 findings are fixed: shallow rebases can use the captured default base under a remote-session lease; saved PR URL/number reads remain revision-bound across provider I/O; directory projection locks and rereads the current connection. Declared Gate 3 remainder was excluded; this is not gate acceptance.
