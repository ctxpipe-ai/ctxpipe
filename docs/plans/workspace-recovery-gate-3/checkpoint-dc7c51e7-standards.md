# Gate 3 G3-C correction / G3-D milestone — Standards review

Pinned increment: `ce00e052b18bceda71909afde37443070b03f5a8..dc7c51e77441d69ead16602f6263624964136dd9`

## Documented-standard violations (1 blocker)

1. **An adopted, already-satisfied first revision is never hydrated.** After the unborn broker returns `initialized`, the workflow adopts the real revision and enters the ordinary bootstrap path (`apps/backend/src/openworkflow/workflows/workspace-bootstrap.ts:180-244`). If that human root already contains the generated files, the no-op branch marks the job completed and returns at `:329-343`; only the commit path schedules hydration at `:404-419`. The earlier empty-repository hydrate necessarily returned without a revision, so without an independent webhook the new Git root remains absent from active projection/serving. This violates ADR-033:7,19,59: hydrate the canonical result after publication, and let only a real committed Git result enter hydration. Schedule the adopted revision’s hydrate durably before no-op completion and assert active projection/knowledge in the “satisfied first writer” native case; that test currently checks Git and replay only (`workspace-unborn-bootstrap-native.contract.test.ts:258-276`).

The prior null-commit replay blocker is closed: `completed + null` returns `no_changes` only when the durable job contains an adopted revision (`workspace-bootstrap.ts:97-123`). A malformed untouched root still fails. Root commit subject generation is a separate durable step, satisfying ADR-033:13.

G3-D’s proof conforms to TDD/mocking rules: it runs the production owner, producer, index, extractor/model client, typed workflow, PostgreSQL, native Git, and codesearch; MSW substitutes only GitHub/model HTTP. The held old clone verifies captured reads retain their SHA while ordinary file/search readers retain the newer published revision. Namespace fixture changes align production owner identity with ADR-033:55.

## Fowler heuristic backlog (9; non-blocking)

Retained without re-investigation: **Mysterious Name (2)**, **Repeated Switches (1)**, **Duplicated Code (6)**. No new heuristic.

**Blockers: 1.** G3-E–G were excluded.
