# Gate 3 G3-C/E/runtime/CI milestone — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed cumulative base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Resolved pin: `f95422b8c35620246ddbb884c2c6e82a5b5f64a7`; reviewed increment `dc7c51e77441d69ead16602f6263624964136dd9..f95422b8c35620246ddbb884c2c6e82a5b5f64a7` (one commit, 42 paths, +1,972/-108).
- Pin and fixed merge base verified. Read-only inspection used pinned `git diff`, `git log`, `git show`, and `git grep`; no tests or implementation changes.

## Standards and exclusions

- Root/backend `AGENTS.md`; code-review and TDD/mocking skills; ADR-027/033; accepted remaining/status ledger.
- Reviewed C correction, E proof seams, runtime ownership, and CI partition. G3-F and tooling-enforced matters excluded. Nine earlier Fowler judgments retained without re-investigation.

## Changed-surface and caller ledger

- **Adopted bootstrap:** traced `pushUnbornWorkspaceCommit` initialized outcome → locked exact-candidate adoption → `hydrate-initialized-revision` admission with read revision → normal bootstrap no-op/commit → completed-row replay. Hydration is durably admitted before no-op completion. The seven-mode native contract registers the hydrate workflow and waits for `activeProjectionSha` in the satisfied-first-writer case.
- **Resource fault seam:** inspected `holdDockerAllocationReply`: Unix Docker endpoint discovery, named semantic-container filter, real upstream request/body forwarding, capture of the 201 allocation identity, held reply, explicit release, connection close, and temporary-socket cleanup through the owning fixture directory.
- **Worker-loss cases:** traced real semantic conflict creation, deterministic resource plan, cleanup scheduling, Docker create/recovery, held model response, SIGKILL, two replacement Bun processes, same container ID, validated merge, one write credential/commit, parent cleanup, expiry-cleanup terminal status, child/process cleanup, and failure diagnostics. MSW’s Docker passthrough is opt-in; existing non-Docker fixtures remain fail-closed for unexpected HTTP.
- **Fixture extension:** checked `nativeDocker` passthrough and refreshable revision capture. Existing environment save/restore and database/Git/graph/server teardown remain intact.
- **Runtime:** checked root engine, prerequisite semantic-version floor, both CI Bun setup sites, backend/worker/UI/docs/codesearch/Zoekt image bases, and repository-wide active version references. Historical evidence logs were not treated as runtime configuration.
- **CI partition:** traced backend package script and root contract script into `test-suite.mjs`; discovered test inventory → explicit contract set → complementary selection → inventory artifact → Vitest JSON result → `check-test-report`. Required paths fail missing, both selected lanes fail empty, contract baseline remains empty, runner errors/signals/timeouts fail, and list mode skips execution side effects. Reviewed `.github/workflows/ci.yaml`, contract registry, prerequisite gate, and failure baselines. Reported preview counts are backend 209 + contract 36 = 245, zero overlap/missing.
- **Docs/evidence:** checked ADR-033 runtime/resource update, remaining/status scope, prior dc7 review artifacts, and recorded C/E/runtime/partition evidence. Reported native/type/policy results were not rerun.

## Counts

- Documented-standard violations: **0**
- Blocking findings: **0**
- New Fowler heuristic judgments: **0**
- Fowler backlog retained: **9**
