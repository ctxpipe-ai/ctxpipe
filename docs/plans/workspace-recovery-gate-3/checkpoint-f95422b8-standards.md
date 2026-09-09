# Gate 3 G3-C/E/runtime/CI milestone — Standards review

Pinned increment: `dc7c51e77441d69ead16602f6263624964136dd9..f95422b8c35620246ddbb884c2c6e82a5b5f64a7`

## Documented-standard violations

None in the reviewed increment.

The prior adopted-root hydration blocker is closed. The initialized revision is converted to read access and durably admitted to `workspaceHydrate` immediately after exact-candidate adoption (`apps/backend/src/openworkflow/workflows/workspace-bootstrap.ts:180-201`), before either the normal no-op or commit branch. The native satisfied-first-writer case now waits for that SHA as the active projection before replay. This follows ADR-033’s real-revision-only hydration and retry ordering.

The E proofs preserve ADR-033’s ownership boundary. A Unix-socket proxy withholds one successful named Docker allocation response while forwarding the real Docker API; another case holds the real structured model request. After SIGKILL, two replacement processes reuse the same durable locator/container, publish one commit, and observe the independently scheduled cleanup workflow complete. GitHub/model HTTP alone is substituted, consistent with TDD/mocking guidance. Fixture cleanup releases held operations, kills every child, closes proxy/server, and removes a surviving owned container.

Bun `^1.4.2`, CI setup, prerequisite validation, and all six production Bun image bases agree on the observed working runtime floor. The failed 1.3.11 HTTP-upgrade probe is recorded as a runtime incompatibility rather than product evidence.

The CI runner partitions the one discovered backend inventory by the explicit contract set: backend and contract selections are complements, required contract paths are existence-checked, and empty selections fail. Normal execution retains prerequisites, allowance-history checks, inventory/result artifacts, signal/timeout failure, and report validation; `--list` performs selection only. The contract lane keeps its zero-failure baseline and 1,200-second bound.

## Fowler heuristic backlog (9; non-blocking)

Retained without re-investigation: **Mysterious Name (2)**, **Repeated Switches (1)**, and **Duplicated Code (6)**. No new heuristic.

**Blockers: 0.** G3-F was excluded.
