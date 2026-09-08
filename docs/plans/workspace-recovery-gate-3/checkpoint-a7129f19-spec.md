# Gate 3 config-admission checkpoint — Spec review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...a7129f1973caea687ae3420fc2e36fe730dd8fa8`
**Decision:** fail for implemented scope — 1 P1, 1 P2.

## Findings

**[P1] Superseded Notion and Confluence proposals leave their generated PRs open — `apps/backend/src/openworkflow/workflows/notion-sync-config.ts:91-118`, `confluence-sync-config.ts:93-118`.** If repository binding or `contentSyncGeneration` advances while either provider creates its PR, the fenced finalization fails: Notion checks `transitioned` and throws, while Confluence’s `requireConfluenceSyncTargetWrite` correctly throws on UPDATE 0 (`models/confluence-sync-target.ts:36-48,198-249`). Neither workflow closes the PR it just created, however. Linear handles the same race by closing that PR before failing (`linear-sync-config.ts:123-137`). The stale proposal therefore remains mergeable even though its native owner failed and a newer binding/generation owns setup. ADR-033:25 requires generation-fenced config finalization, and the recovery plan:451 requires asserting **“durable rows, and resource cleanup.”** Return enough PR identity from both sync functions to close the just-created PR on CAS loss before rethrowing.

**[P2] Semantically identical proposals do not reliably reuse their native owner — `apps/backend/src/openworkflow/enqueue-connector-content-sync.ts:12-15`, `enqueue-connector-config-sync.ts:43-57`.** The idempotency key hashes raw `JSON.stringify(selection)`, while Linear and Notion compare/render canonical sorted selections (`services/linear/config-yaml.ts:64-88`; `services/notion/config-yaml.ts:82-113`) and Confluence’s pending check sorts spaces/page IDs (`models/atlassian-connector.ts:886-906`). Reordering a selection (or changing Notion URL/parent metadata that YAML ignores) during a pending proposal therefore produces a different key; `prepareConnectorSync` treats it as a competing proposal and returns 409 rather than reusing the owner. ADR-033:25 promises **“Repeated config events reuse the current owner.”** Hash each provider’s canonical, persisted YAML projection.

## Verified

Both prior 4a Spec findings are closed: legacy owners have own-run replay plus explicit bounded recovery, and pre-activation canceled content owners persist terminal ownership and admit a next-generation retry. Owner-first admission, lost-response lookup, immutable new Confluence inputs, cancellation projection, completed-owner acknowledgment, and webhook rethrow are otherwise consistent. Declared remaining Gate 3 work was excluded; this is not gate acceptance.
