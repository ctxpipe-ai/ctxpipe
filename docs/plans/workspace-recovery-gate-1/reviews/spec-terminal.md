# Gate 1 adversarial terminal review — `d8785835`

**Final verdict: PASS — Gate 1 is complete with zero blockers.**

Reviewed fixed range `7dfa6b93a5baedc3eb2c86dd1056662e89cace00...d87858354a783a9fd95c46785208c9b699a45e3b` (275 files, 40,838 insertions, 473 deletions). `git rev-parse` and an independent `git ls-remote origin refs/heads/codex/develop-plan-to-refocus-branch-direction` both resolved the terminal checkpoint to `d87858354a783a9fd95c46785208c9b699a45e3b`. The review used the complete diff, Gate 0 classification manifest at its immutable commit, ADR-031, the recovery plan, retained local/CI evidence, and repository-wide searches. I independently parsed `docs/plans/workspace-recovery-gate-1/logs/ci-d8785835-complete.json`: GitHub Actions run `34174216707` is completed/success at that exact head SHA, with 13 unique jobs and every job completed/success. No Gate 1 correctness, security, migration, performance, or test-oracle blocker remains.

## Requirement matrix

| Gate 1 requirement | Verdict | File evidence and proof meaning |
| --- | --- | --- |
| 1. Full typecheck or finite diagnostic-specific shrinking allowances (plan 604–605) | **PASS** | `scripts/ci/projects.json:1-30` names all seven projects. `scripts/ci/typecheck-all.mjs` invokes each project and its baseline; `scripts/ci/typecheck.mjs:61-124` emits every TypeScript error and rejects new, count-changed, and stale identities; `scripts/ci/check-allowlist-history.mjs:14-51` requires full Git history and prevents growth. `.github/workflows/ci.yaml:54-72` runs the full command. Exact-checkpoint CI passed. Retained execution reports backend 177, UI 391, codesearch 11, and zero CDK/CLI/self-host/docs allowances. |
| 2. Production builds for every affected runnable/package surface (606) | **PASS** | `.github/workflows/ci.yaml:147-173` builds backend, worker, UI, codesearch, docs, and OpenTelemetry Dockerfiles with a 30-minute bound; lines 175-197 build backend/codesearch entrypoints and distributable CDK/CLI and check self-host. Lines 199-231 run codesearch's real toolchain and credential-free Terraform validation. Each production Dockerfile was inspected; dependency/frontend builders use Node 22 while runtime stages retain their declared runtime. Run `34174216707` passed every image, package/toolchain, and Terraform job at exact `d8785835`. |
| 3. Explicit prerequisites; missing binary or skipped proof fails (607–608) | **PASS** | `.github/workflows/ci.yaml:81-145` provisions pgvector, Bun 1.3.11, OpenCode 1.18.18, migrations and app role, then requires result artifacts. `scripts/ci/prerequisites.mjs:6-48` validates Node/git/Bun/OpenCode and versions. `scripts/ci/test-suite.mjs:27-101` discovers an unfiltered Git inventory, fails empty/missing contract selections, builds CLI/stamps CDK, rejects runner error/signal, and verifies the report. `scripts/ci/check-test-report.mjs:16-92` rejects zero tests, skip/todo, suite/hook/process mismatch, inventory mismatch, unexpected/stale failures, and inconsistent totals/exit. The exact-checkpoint Tests job passed. |
| 4. Deterministic PostgreSQL, git, local sandbox, hydrate, job-runner, and chat lanes (609–610) | **PASS for Gate 1 characterization** | `scripts/ci/contracts.json:1-17` enumerates seven required files. PostgreSQL contracts exercise RLS with the non-bypass app role and sandbox persistence; native-git and `job-sandbox.live.test.ts` use real processes/files. `hydration.contract.test.ts:26-139` executes real PostgreSQL OpenWorkflow for 0/1/100-file bare remotes and asserts durable state/SHA/embeddings; only external embedding HTTP is substituted. `write-workflow.contract.test.ts:22-131` executes every one of 12 schema write kinds once through real PostgreSQL OpenWorkflow, asserts the named existing `requireCurrentOrgId` durable failure/one attempt/no domain job row, and compares complete remote refs before/after. `tanstack-workspace-chat.multiturn.test.ts:345-424` uses PostgreSQL, local sandbox, pinned OpenCode and Hono model proxy; turn two is built from persisted turn one, official `reconstructChat` is checked, and destruction removes rows. Successful write/CAS/push belongs to Gate 3; restart/race/resume chat proof belongs to Gate 4. |
| 5. Reject new skip/fails/todo/retries/owned mocks in proof (611–612) | **PASS** | `scripts/ci/check-test-policy.mjs`, `scripts/ci/test-configuration.mjs`, and `scripts/tests/ci-test-policy.test.mjs` parse the syntax and configuration/command graph rather than regex-selecting tests. The final implementation covers local/destructured/namespace/imported aliases; Playwright fail/fixme; option objects through identifiers, spreads, tuples, computed/getter/shorthand keys, mutation and freeze/seal/assign wrappers; owned `mock.module`; ESM/re-export/CJS/dynamic/custom config paths; YAML folded commands; shell/package/workflow forwarding through pnpm filter/`-C`, npm workspace and Turbo; and both finite CI runners' literal/template retry argv. Namespace assertions and `each`/`for`/`extend` data remain valid. Independent rerun: five public script checks passed and the policy scanned 433 source/config/runner files plus 27 command files with no violation. The immutable Gate 0 TSV prevents reclassification in the candidate. |
| Exit: green means stated modules executed; existing failures visible (614–615) | **PASS** | `.ci-results` inventories/reports are mandatory; exact allowances contain identity and error and fail when new, changed, or stale. Retained local evidence records backend 1,480 cases (1,479 pass + one named existing failure, zero skipped), contracts 23/23, UI 291, CLI 93, CDK 32, and codesearch 221 across all 33 files (184 Node + 37 Bun). `docs/plans/workspace-recovery-gate-1/baseline.md:36-55` retains raw passing and failed attempts instead of converting infrastructure/product failures into skips. Exact-checkpoint run `34174216707` passed Tests, Codesearch contracts, Typecheck and Biome. |

## Codebase coverage map

| Subsystem / entry points searched | Evidence inspected |
| --- | --- |
| Workflow and command entry points | All `.github/workflows/*`, root and workspace `package.json` scripts, shell runners, the two finite CI runner modules, YAML folded/multiline commands, standard/custom Vitest/Playwright config discovery, local ESM/re-export/CJS/dynamic config graphs. |
| TypeScript coverage | All affected `tsconfig.json` entries in `projects.json`; `typecheck-all.mjs`, `typecheck.mjs`, diagnostic baselines, history enforcement, generated CDK/docs prerequisites. |
| Test inventory and oracle | `test-suite.mjs`, `check-test-report.mjs`, `check-test-policy.mjs`, `test-configuration.mjs`, failure baselines, policy regressions, immutable Gate 0 classification, runner exit/signal and artifact behavior. |
| Database and migration | Backend schema/migrations, OpenWorkflow/checkpoint migrations, app-role provisioning, RLS and sandbox-persistence contracts, fresh/previous-schema job at `.github/workflows/ci.yaml:233-278`. |
| Git, hydrate, projections | Native clone/tree contract, temporary/bare remotes, complete ref snapshots, hydrate workflow and 0/1/100 fixtures, committed contents/active SHA/embedding phase/cleanup. |
| Sandbox, jobs, workflows | Local process/worktree contract, OpenWorkflow worker/backend/client, all schema-declared write kinds, durable failure record, job-row and remote-ref non-mutation. |
| Chat engine and transport | HTTP/model proxy, WebSocket stream, PostgreSQL message/instance stores, persisted two-turn input, official reconstruction, OpenCode subprocess, local sandbox and teardown. |
| UI | UI package entry/build, unfiltered Vitest suite and runner config; 61-file inventory and 291 executed cases. |
| Codesearch | Package/build/server/routes, Node/Bun test partition, every discovered test, real toolchain runner, amd64 production image/tooling. |
| Other affected surfaces | CLI build/test/package, CDK image-stamp/build/test, self-host typecheck, docs build/image, backend/worker/UI/docs/otel images, Terraform validation. |
| Cross-tree ownership search | Complete changed-file list plus repository-wide searches for test suffixes/selectors, `skip`/`todo`/`fails`/`only`/retry forms, module mocks, filtered diagnostics, config imports/re-exports, Git commit/push/ref operations, workflow/route/background/UI entry points, compatibility/old recovery vocabulary, and files outside expected directories. |

## Blocking finding classes

| Class | Result |
| --- | --- |
| Correctness | No blocker. Inventories, exits, prerequisites, exact failures and deterministic contracts support the claimed Gate 1 meaning. |
| Security | No blocker. PostgreSQL proof uses the app role that cannot bypass RLS. Push credential ownership and successful write behavior are expressly Gate 3 work. |
| Migration | No blocker. Gate 1 adds no product schema ownership; the exact-checkpoint fresh/previous-schema migration and app-role isolation job passed. |
| Performance | No Gate 1 blocker. Production builds and codesearch have finite 30-minute limits. Product latency/request/resource budgets are Gate 4/6 acceptance work. |
| Test oracle | No blocker. Source/config/command policy, discovered inventories, structured result validation, exact/stale allowance checks and preserved failure logs close the identified false-green paths. |

## Surviving owners and explicit later-gate disposition

These are visible and intentionally remain because Gate 1 must make CI truthful **without fixing product behavior**; they are not Gate 1 blockers.

- **Gate 2:** redundant revision/projection reconstruction, provider-specific/per-file repository paths, and contradictory revision/generation/derived-store ownership. Replace with `WorkspaceRevision`/`ProjectionState`, native-git acquisition and activation CAS before deletion.
- **Gate 3:** the 12 exact write-error characterizations, missing-org-context write failure, generic/write-intent runner ownership, duplicate workflow choreography, and any default-branch commit/push or credential issuance path. Replace with successful typed OpenWorkflow stage/validate/commit/CAS/push, retry/idempotency/conflict/uncertainty proof, then delete superseded owners.
- **Gate 4:** mocked `.live.test.ts` chat transport characterization, process registry/definition and duplicate route acquisition, manual terminal/persistence repair, catch-and-empty paths, and warm-turn GitHub/tool construction. TanStack definition/store/chat/reconstruct ownership, restart/two-replica/race/resume/cleanup proof replaces them.
- **Gate 5:** compose/route/pending identity reconciliation, render-time repair, duplicate working-tree/publish state, polling/invalidation, UI transport/hook simulations and the broad `WorkspacePane`. Replace with canonical server command, `useChat`/transport disposal and required Storybook Playwright interactions.
- **Gate 6:** finite diagnostic/failure allowances, superseded characterization tests, parallel fixtures/mocks, compatibility mappings/adapters, stale ADR implementation paths/state columns, and recovery-only scaffolding. Remove after deeper proof and migration safety exist; rerun full manifest, golden journey, budgets, leak checks and deletion ledger.

Gate 1 already removed its own obsolete false-green mechanisms: typecheck path filtering, backend integration/RLS exclusions, OpenCode opt-in skips, Bun.Glob skips, UI empty-suite success, and the CLI empty live-eval placeholder (`baseline.md:108-120`). I found no remaining Gate 1-owned compatibility path or caller that should be deleted now.

## Commands and searches used

Independent commands included:

```text
git rev-parse d8785835
git ls-remote origin refs/heads/codex/develop-plan-to-refocus-branch-direction
git diff --name-status 7dfa6b93...d8785835
git diff --stat 7dfa6b93...d8785835
git diff 7dfa6b93...d8785835 -- <workflow/script/test/build surface>
git log --format='%H %s' 7dfa6b93..d8785835
git ls-tree -r --name-only d8785835
git show d8785835:<path>
node --test scripts/tests/ci-test-policy.test.mjs
node scripts/ci/check-test-policy.mjs
node -e '<parse ci-d8785835-complete.json; require exact SHA, completed/success, 13 unique completed/success jobs>'
```

Repository searches used `rg --files` and `rg -n` across the complete tree for AGENTS/review instructions; all workflow/package/shell/config/runner/test files; test modifiers and aliases; `mock.module` and owned seams; retry/retries and forwarded runner arguments; diagnostic filtering and allowances; Dockerfiles/build/package surfaces; PostgreSQL/RLS/migration/OpenWorkflow callers; git clone/ref/commit/push calls; hydrate/revision/projection; sandbox/process/job-runner; chat HTTP/WebSocket/reconstruction/persistence/cleanup; and UI/codesearch/CLI/CDK/docs/Terraform entry points. I inspected the unfiltered suite inventories and retained command/log metadata in `docs/plans/workspace-recovery-gate-1/logs/`; I did not represent those retained executions as independent reruns.

## Final closure evidence

GitHub Actions run `34174216707` completed successfully with 13/13 jobs at head SHA `d87858354a783a9fd95c46785208c9b699a45e3b`. Its recorded jobs cover Biome/policy regressions, full typecheck, tests/contracts, runnable packages/examples, codesearch contracts, Terraform, fresh/previous-schema migrations, and all six production images. The independently queried remote branch still resolves to the same SHA. The exact reviewed checkpoint therefore satisfies the Gate 1 exit and adversarial review protocol with **zero blockers**; the named Gate 2–6 items above remain owned follow-ups rather than Gate 1 debt.
