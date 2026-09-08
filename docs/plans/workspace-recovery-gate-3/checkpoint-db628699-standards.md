# Standards review — `db628699f5b15a7fba03589fbfbe7746b54a723e`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...db628699f5b15a7fba03589fbfbe7746b54a723e`
**Result:** 0 documented-standard violations; 1 heuristic smell; 0 implemented-scope blockers.

## Documented-standard violations

None found. ADR-033:24 requires a connector parent to capture its bound revision before provider fetch, persist only content/non-secret metadata, invoke the typed mirror with native `step.runWorkflow`, and avoid treating child suspension as failure. The Linear full and entity parents satisfy that boundary (`linear-sync-content.ts:52-161`; `linear-sync-entity.ts:57-188`), and the native contract scans parent and child durable inputs/attempts for the fixture token (`linear-mirror-native.contract.test.ts:94-193`). Token refresh performs its HTTP callback between two short SQL scopes (`linear-connector.ts:370-451`), satisfying ADR-027 and ADR-033:25. The no-op path now refreshes and compares binding/revision without requiring write permission (`write-broker.ts:235-256`). Rename planning captures the prior SHA only for the same full binding and persists it through reservation/replay (`workspace-hydrate.ts:135-221`; `workspace-write-planning.ts:45-131`). The earlier direct `console.*` breach is removed.

## Fowler heuristic smells (judgment call)

### Duplicated Code — Linear parent orchestration

`linear-sync-content.ts:52-161` and `linear-sync-entity.ts:57-188` repeat the same target/connection/config capture, authorization reload, token-refresh callback, and mirror-child input assembly. This is not a documented breach: ADR-033 intentionally keeps native step ownership explicit. Still, credential-lifetime or binding changes now require parallel edits. Share pure helpers for the validated Linear capture context and refresh handler while leaving each parent's `step.run` / `step.runWorkflow` sequence explicit.

The open connector finalization/binding-race audit and other Gate 3 remainder in `write-path-audit.md` were treated as declared future scope, not checkpoint findings.
