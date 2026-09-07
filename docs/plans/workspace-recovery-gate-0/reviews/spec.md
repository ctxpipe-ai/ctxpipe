# Gate 0 independent Spec review

Initial local review: 2026-09-07. Exact remote review completed: 2026-09-08 (Australia/Melbourne).

## Review identity and verdict

- Axis: Spec, performed independently under `.agents/skills/code-review/SKILL.md`.
- Fixed starting checkpoint: `f632772cb10e4a220923acf4278b47e2295a5e94`.
- Local candidate reviewed: `cd45f59881b70b8612b498993a518f49425482c4`.
- Original evidence candidate: `0290b161efa6e6462f6dfaab1e564994871c66a3`.
- Corrective range reviewed: `0290b161efa6e6462f6dfaab1e564994871c66a3...cd45f59881b70b8612b498993a518f49425482c4`.
- Full implementation range reviewed: `f632772cb10e4a220923acf4278b47e2295a5e94...cd45f59881b70b8612b498993a518f49425482c4` (six commits).
- Local repository state after review: clean; local HEAD and upstream agree.
- Direct remote verification: `git ls-remote origin refs/heads/codex/develop-plan-to-refocus-branch-direction` resolved to `cd45f59881b70b8612b498993a518f49425482c4`.

**Exact-remote Spec verdict: PASS with zero Gate 0 Spec blockers for `cd45f59881b70b8612b498993a518f49425482c4`.**

The public remote checkpoint is now satisfied for this candidate. The recovery protocol still requires the coordinator to record the final SHA and review results in the repository, push that metadata commit, and obtain the planned narrow review of the new terminal SHA. Any commit made after this review is outside this review identity and requires that terminal-SHA check.

The recorded product failures are truthful Gate 0 baseline findings owned by later gates.

## Specification sources reviewed

I reviewed the repository `AGENTS.md`, the full code-review skill, the complete `docs/plans/workspace-chat-recovery.md`, all 19 files under `.ai/scratchpad/git-backed-projects/issues/`, the accepted Workspace chat PRDs for latency, models, and sandboxes, ADR-026 through ADR-030, and ADR-008 referenced by ticket 08. I also traced the candidate outside the expected Workspace directories through schemas, migrations, OpenWorkflow, CI, deployment definitions, codesearch, CLI, CDK, Forge reference material, OTEL, Terraform, and repository-level scripts.

ADR-008 does not appear in the PR-range changed-file manifest because it is unchanged in PR 280. It was nevertheless reviewed as a governing topology decision: backend and codesearch remain separate, with no shared Zoekt volume. That is consistent with the recovery plan.

## Requirement-by-requirement matrix

| Gate 0 requirement | Evidence reviewed / independent check | Result | Qualification or later owner |
| --- | --- | --- | --- |
| Fixed, reviewable candidate | Resolved local HEAD to `cd45f59881b70b8612b498993a518f49425482c4`; merge-base with the fixed checkpoint is the checkpoint itself; six-commit log inspected; worktree clean. Direct `ls-remote` resolves the public branch to the same SHA. | PASS | Exact local and remote identities agree. |
| Fetch full PR 280 ancestry and exact merge base | Independently recomputed PR merge base `9072089086f6fad87fbf05572b9f1ff5336e0520`; PR head is `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`; GitHub base ref OID is `95201c3d210775f9350f63595dc6d13d64d2eb6c`. Archived GitHub metadata agrees. | PASS | PR ancestry and candidate publication are complete. |
| Authoritative commit/file/line statistics | Independent native-git computation produced 465 commits, 801 files, +148,441/-13,326. Archived GitHub metadata reports the same totals. The complete sorted manifest has 801 paths and SHA-256 `3695cdf07c70b3001a98043a275ec063b914fd43cc7d96beada6aee71e123c27`. | PASS | Binary paths are counted as files and correctly excluded from numeric line totals. |
| Changed package/surface list | `affected-surfaces.txt`, `baseline.md`, the 801-path manifest, package scripts, deployment files, migration paths, and the new `surface-coverage.md` were cross-checked. | PASS | The evidence now states exactly which deploy-only surfaces were inspected but not executed. It makes no production deployment claim. |
| Frozen install | Node 22.16.0 frozen `pnpm install` completed successfully with exact command metadata and raw log. | PASS | The earlier host/runtime probes remain diagnostic and are not substituted for this lane. |
| Full typecheck | Unfiltered backend and UI typechecks ran and failed visibly. The correction adds successful CLI `check` and self-host-example typecheck evidence. | PASS as truthful baseline | The type errors are Gate 1 work; Gate 0 must retain them rather than demand a green product. |
| All affected declared builds | Recursive `--no-bail --if-present build` invoked all six declared build scripts: backend, codesearch, UI, docs, CLI, and AWS CDK. Backend and codesearch failed; four passed. | PASS as truthful baseline | Forge reference, OTEL, Terraform, and the self-host example have no equivalent declared build script. Their non-execution is explicit. CDK/AWS, Forge, Terraform, and live infrastructure deployment are not claimed. |
| All affected tests | Backend default lane covered 232 of 235 tracked backend files, RLS ran explicitly, and the correction explicitly ran the two files excluded by default Vitest configuration. MCP conformance: 2 pass. Ingestion retraction: 4 fail at application-role RLS fixture insertion. UI, packages/CLI/CDK, codesearch Docker, OpenCode live, and full Storybook interaction evidence is archived. | PASS as truthful baseline | All 235 backend test files now have an execution lane. Codesearch has two named skips; CLI has one named skip; Storybook has 24 failures. These are visible baselines, not Gate 0 omissions. |
| Migrations | Fresh migration passed. The pinned exact merge-base-to-PR-head Drizzle upgrade helper passed against a disposable Postgres/pgvector database and cleaned up. RLS app-role lane passed. | PASS for Gate 0 | This does not claim a live production rollout, Terraform apply, CDK deploy, Forge deployment, or full Gate 6 deployment acceptance. |
| One manual golden journey | A clean real signup/org/workspace attempt was made. Native local-remote tip resolution failed at step 1; steps 2-9 are explicitly `NOT_REACHED`. Seeded-SHA, synthetic-writable, direct API, WebSocket, restart, and cleanup continuations are separately labeled diagnostics. | PASS as a failing baseline attempt | It is not successful Tier-5 proof. Later gates own tip resolution, Home first-send, transcript/worktree reuse, publish, restart, and cleanup fixes. |
| Latency baseline | Canonical uninstrumented 5-cold/20-warm series and a separately named instrumented 5-cold/20-warm series are retained. Cold/warm first-text and terminal distributions are reported without dropping slow samples. | PASS | The series uses seeded SHA and HTTP/SSE; it is neither browser/WebSocket latency nor successful clean-journey latency. Successful hydrate/job/publish phase timings are censored as `NOT_REACHED`. |
| Request and DB counts | UI request windows record 20/128/256 requests over cumulative 5/30/60-second windows. Instrumented database statements cover the whole workspace GET + prepare + send + history sample, including transactions: cold 215/215/215 and warm 221/221/221 p50/p95/max. | PASS | Counts are correctly not described as send-endpoint-only. Windows are cumulative, not independent repeats. |
| Provider-call baseline | Runtime evidence records 50 real model-proxy requests, zero GitHub calls/bytes for the native local fixture, 25 distinct OpenCode sessions/directories, `attached:false`, and an ensure invocation per sample. | PASS with explicit instrumentation boundary | Exact external sandbox-provider create/attach API call totals were not intercepted; the 25 distinct sessions/directories establish at least 25 non-reused outcomes. Zero GitHub calls is explicitly not proof of a GitHub-connected path. Later contract instrumentation should make provider calls exact. |
| Flake rate | The narrow HTTP/SSE oracle passed 25/25 in each series and is explicitly described as neither UI/golden proof nor a statistical guarantee. Storybook and clean-journey failures remain separate. | PASS | The oracle only checks HTTP 200, one terminal, no run error, and expected Clockwork text. |
| Cleanup/resource observations | All 52 captured measured/manual model directories are absent. DB rows are zero. One extra navigation-created directory still exists after production DELETE despite zero DB rows; this is stated as a leak. | PASS as truthful baseline | Gate 4 owns the cleanup defect. Two unrelated pre-existing OpenCode processes were preserved and not falsely attributed to the samples. |
| Test classification | Independently compared the TSV to every tracked test/story file under apps/packages/examples at PR head: exactly 421 expected, 421 rows, 421 unique paths, no missing or extra paths. Totals are 343 tests + 78 stories; 207 proof + 214 characterization; zero redundant/unclassified. Every row has owner and evidence text. | PASS | Classification records oracle strength, not execution success. Gate 0 harness tests created after the PR head are validation machinery and intentionally outside the fixed PR-head inventory. |
| Reproducible, intact evidence | 121 SHA-256 entries all match; all 50 JSON files and all records in 9 JSONL files parse; all 23 evidence rows reference existing artifacts. Both collector and runner regression suites pass on the final local candidate. | PASS | The SHA manifest is a selected artifact-integrity ledger, not a hash of every narrative file. |
| Security of archived evidence | Pattern scan found no model/API key, GitHub token, private key, AWS access key, or bearer credential. The apparent `sk-...` match is only the substring in `packages/aws-cdk/src/internal/task-definitions-construct.ts` inside the changed-path manifest. | PASS | Disposable local DB/auth fixture values remain in command metadata as intended. |
| Exact pushed SHA and independent final review | Direct `git ls-remote` returns `cd45f59881b70b8612b498993a518f49425482c4`; local HEAD and upstream resolve to the same SHA. This fresh Spec review reports no blockers for that exact remote commit. | PASS | The coordinator will now commit the final status/review metadata; that new terminal SHA needs the planned narrow review before Gate 0 is closed. |

## Corrective review findings resolved locally

The first evidence candidate, `0290b161efa6e6462f6dfaab1e564994871c66a3`, had four material evidence defects. The correction commit `cd45f59881b70b8612b498993a518f49425482c4` resolves each without altering PR 280 product code:

1. Five files were over-classified as proof because owned modules were mocked or because the file mixed narrow proof with newly added characterization cases. The corrected rows are `checkout-read.test.ts`, `tanstack-workspace-chat.live.test.ts`, `conversation-files-routes.live.test.ts`, `modelProvider.test.ts`, and `workspaceChatWebSocket.test.ts`. Totals changed from 212/209 to 207/214.
2. `ingestionRetraction.integration.test.ts` and `mcp.conformance.test.ts` were excluded from the default backend Vitest configuration and had no explicit lane. The correction runs both through a small config wrapper that preserves backend setup and removes only exclusions. Their real outcomes remain visible.
3. The root/CLI `check` and self-host example `typecheck` surfaces were not separately executed. Both now have passing Node 22 evidence.
4. Coverage language could be read as deployment validation. `surface-coverage.md` now names all executed build/test/typecheck surfaces and states the Forge, OTEL, Terraform, AWS deployment, and production-runtime limits. The plan also no longer describes the 19 historical design tickets as all “resolved.”

No additional local Spec blocker remains after these corrections.

## Repository-wide coverage map

The 801 changed paths are distributed across the whole repository rather than only the expected Workspace directories:

| Surface | Changed paths | Spec relevance and reviewed evidence |
| --- | ---: | --- |
| `apps/backend` | 387 | Workspace domain, routes, models, schemas, RLS, OpenWorkflow, connector ingestion, worker, Dockerfiles, migrations, chat/files/publish paths. |
| `apps/ui` | 272 | Workspace/Home routes, TanStack chat, Pierre file surfaces, request/polling behavior, Vitest and 371 Storybook interactions. |
| `.ai` | 48 | All 19 design tickets, PRDs, ADRs in range, memory/glossary/lessons, design assets and issue map. |
| `apps/codesearch` | 34 | Search/graph/index phases, DB schema, Docker lane, OOM simulation, backend/codesearch topology. |
| `apps/docs` | 11 | Production build surface. |
| `.cursor` | 10 | Repository guidance/rules in PR scope. |
| `packages/aws-cdk` | 8 | CDK build/tests, app-role/secrets/task definitions, deploy-time migration resources. No AWS deploy is claimed. |
| `packages/cli` | 7 | Build, 93-pass/1-skip test lane, and full CLI `check`. |
| `.github` | 6 | CI, CLI, deploy and preview workflows; current filters/skips are Gate 1 owners. |
| root/other | 6 | Root package/lock, compose files, and other root configuration. |
| `infra` | 5 | Terraform/Neon/Railway sources reviewed; no plan/apply claimed. |
| `scripts` | 4 | Scope collector and runner plus their regression fixtures. |
| `.changeset` | 2 | Package/change documentation including app DB role. |
| `examples/aws-cdk-self-host` | 1 | Full typecheck executed; synth/deploy/E2E not claimed. |

The affected-surface inventory additionally calls out the Forge reference and OTEL collector because their runtime/deployment roles matter even though their changed-path counts are folded into the app tree and they lack normal build/test scripts. A repository-wide term search for workspace, sandbox, OpenWorkflow, revision, projection, hydrate, OpenCode, or conversation found 644 files outside the Gate 0 evidence directory: 608 under apps, 12 under packages, 7 under scripts, 5 under infra, 3 under docs, 3 under examples, 1 under proposals, and 5 at repository root. The review used this search to examine seams beyond `apps/backend/src/domain/workspaces` and `apps/ui/src/features/workspaces`.

The migration/deployment audit covered nine Drizzle migration directories, backend schema modules, OpenWorkflow migrations/configuration/workflows, backend and worker Dockerfiles, UI Dockerfile, compose, all six changed GitHub workflows, CDK migration/secrets/task resources, Terraform, Forge reference material, and OTEL collector configuration. The baseline correctly distinguishes a local command from an external deployment prerequisite.

## Recorded failures that are not Gate 0 blockers

Gate 0 requires an honest baseline. The following outcomes must remain visible and should not be converted into Gate 0 product-fix demands:

- Backend and UI typechecks fail; backend and codesearch builds fail.
- Backend’s default command reports failure, OpenCode live fails, ingestion retraction fails during RLS fixture insertion, and Storybook has 24 failed stories.
- The clean journey fails at step 1; all dependent steps are honestly `NOT_REACHED`.
- Seeded hydrate reaches `requireCurrentOrgId is not defined`.
- Home’s first message is lost; the diagnostic produces two prepare/chat/touch request pairs and no model request.
- First-text latency misses the target; warm samples create distinct sessions/directories and retain only three history records.
- File write/diff works only after a synthetic writable fixture; GitHub publish is rejected for the local remote.
- SIGTERM leaves the listener using a closed DB pool; the edit is lost after restart.
- One navigation provider directory remains after delete even though the DB has zero rows.
- Installed OpenCode is 1.3.13 while the product pin is 1.18.18.

These facts give Gates 1-6 concrete owners and preserve the correct failure boundaries. They do not invalidate the completeness of the Gate 0 capture.

## Commands and searches used

Representative independent checks:

```text
git rev-parse HEAD 0290b161 f632772cb10e4a220923acf4278b47e2295a5e94
git merge-base f632772cb10e4a220923acf4278b47e2295a5e94 HEAD
git rev-list --count f632772cb10e4a220923acf4278b47e2295a5e94..HEAD
git log --oneline f632772cb10e4a220923acf4278b47e2295a5e94..HEAD
git diff --stat --name-status 0290b161...HEAD
git diff --stat f632772cb10e4a220923acf4278b47e2295a5e94...HEAD
git diff --name-only 9072089086f6fad87fbf05572b9f1ff5336e0520...1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8
git diff --numstat 9072089086f6fad87fbf05572b9f1ff5336e0520...1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8
git rev-list --count 9072089086f6fad87fbf05572b9f1ff5336e0520..1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8
git rev-parse '@{u}'
git diff --check 0290b161...HEAD -- ':!docs/plans/workspace-recovery-gate-0/logs/**'
rg searches for stale classification/scope counts, `IN_PROGRESS`, deployment/migration/workflow surfaces, and repository-wide Workspace lifecycle terms
Python structural checks for manifest equality/hash, JSON/JSONL parsing, artifact hashes, evidence references, test inventory equality, classification totals, path distribution, and credential patterns
bash scripts/tests/workspace-recovery-baseline.test.sh
python3 scripts/tests/workspace-recovery-runner.test.py
```

Final independent verification results:

- Scope recomputation: 465 commits / 801 files / +148,441 / -13,326.
- Changed-file manifest: exact sorted equality; SHA-256 `3695cdf07c70b3001a98043a275ec063b914fd43cc7d96beada6aee71e123c27`.
- Classification inventory: 421 expected, 421 present, zero duplicate/missing/extra paths; 207 proof / 214 characterization.
- Evidence integrity: 121/121 hashes match; 50 JSON and 9 JSONL artifacts parse; 23/23 ledger rows reference existing artifacts.
- Harness regressions: shell fixture suite passed; four Python runner tests passed.
- Non-log corrective diff: `git diff --check` clean. Raw archived tool logs retain their original whitespace and are evidence, not source formatting.
- Repository status after checks: clean; local HEAD, upstream, and direct remote branch all resolve to `cd45f59881b70b8612b498993a518f49425482c4`.

## Required terminal protocol step

The exact remote candidate reviewed here has no Spec blockers. To close the gate without creating an unreviewed metadata tail:

1. Record `cd45f59881b70b8612b498993a518f49425482c4`, its direct remote verification, and the no-blocker reviews in the Gate 0 status/report.
2. Commit and push only that terminal report/status metadata.
3. Verify the new remote terminal SHA exactly and perform the planned narrow review of its metadata-only diff.

There are no blockers in the exact remote candidate `cd45f59881b70b8612b498993a518f49425482c4`. The terminal metadata commit remains a required protocol step, not a defect in this candidate.
