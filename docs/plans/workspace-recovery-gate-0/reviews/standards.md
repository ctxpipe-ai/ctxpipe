# Gate 0 independent Standards review

## Verdict

Reviewed fixed point `f632772cb10e4a220923acf4278b47e2295a5e94`, initial candidate `0290b161efa6e6462f6dfaab1e564994871c66a3`, and local correction candidate `cd45f59881b70b8612b498993a518f49425482c4`.

The correction candidate has **no remaining Standards blocker**. It resolves the two substantive defects found in `0290b161`: two excluded backend proof files lacked any execution record, and five test files overstated their proof strength. It also removes the inaccurate claim that all 19 design tickets are resolved; ticket 19 is historical.

At `2026-09-07T23:00:28Z`, `git ls-remote origin refs/heads/codex/develop-plan-to-refocus-branch-direction` returned `cd45f59881b70b8612b498993a518f49425482c4`, exactly equal to clean local `HEAD` and the remote-tracking ref. **Standards review passes for that exact remote SHA.** Gate 0 still needs its review/status metadata committed and pushed, followed by the protocol's narrow terminal-SHA review; this report does not pre-approve a later commit.

## Requirement matrix

| Gate 0 / repository requirement | Local result at `cd45f598` | Evidence |
| --- | --- | --- |
| Fixed starting point and non-empty three-dot diff | PASS | Fixed point resolves exactly; six commits through `cd45f598`; diff is non-empty. |
| Full PR ancestry and authoritative totals | PASS | Native git independently returns 465 commits, 801 files, +148,441/-13,326 for `9072089...1fad841`; archived GitHub REST/GraphQL values agree. |
| Complete file manifest | PASS | Fresh sorted `git diff --name-only` is byte-identical to `changed-files.txt` (801 rows). |
| Affected packages, apps, examples, root, CI, migrations and deploy surfaces | PASS | `affected-surfaces.txt` covers all direct surfaces and conservatively includes Forge/OTEL because root workspace inputs changed; `surface-coverage.md` distinguishes executed commands from unexecuted deployment-only surfaces. |
| Install, full declared typechecks/builds/tests, migrations, and manual journey | PASS as a truthful failing baseline | Frozen install passes. Backend/UI typechecks fail with 177/391 diagnostics. Recursive declared builds preserve backend/codesearch failures. All 343 tracked test files now have an execution lane: backend default 232 + RLS 1 + explicit excluded 2, UI 61, codesearch 33, CLI 10, CDK 4. The explicit excluded run records MCP 2 pass and retraction 4 fail at RLS fixture insertion. Fresh and base-to-head migrations pass. The clean journey fails at native tip resolution and is not represented as success. |
| Latency, request counts, provider calls and flake rate | PASS with explicit limits | Two separate 5-cold/20-warm series are retained. The 0/25 figure is scoped only to the per-turn SSE oracle; UI/golden flake proof is explicitly disclaimed. Unreached phases are `NOT_REACHED`, not zero. Query counts include complete sample traffic and transactions. |
| Classify every tracked test/story file | PASS after correction | Fresh PR-head inventory exactly matches 421 unique TSV rows: 343 tests and 78 stories. `has_play` recomputation has no mismatches. Counts are 207 proof / 214 characterization / 0 redundant / 0 unclassified, with owner and evidence on every row. |
| Reproduction tools | PASS | Collector fixture suite passes; runner CLI suite passes 4/4; all Gate 0 Python files compile using a disposable bytecode cache; native fixture bundle passes `git fsck`, resolves to `c331b30e...`, and contains only `AGENTS.md` and `README.md`. |
| Evidence integrity and exact commands | PASS locally | All 121 entries in `artifact-sha256.json` exist and match; every log is hashed; ledger fields are populated. Failures, skips, wrapper exit 126, dirty-state qualifications and diagnostic bypasses are preserved rather than normalized away. |
| Privacy and credentials | PASS for credentials; publication note below | Pattern searches found no GitHub, OpenAI-style, Slack, AWS, bearer, private-key or JWT-shaped credential in the bundle; the sole `sk-...` match is the filename fragment `sk-definitions-construct`. The authorized model key is absent per the supplied exact-key scan. Only public disposable fixture secrets/emails occur. |
| Exact pushed checkpoint and final exact-SHA review | PASS for `cd45f598`; terminal metadata review remains | Live `git ls-remote` returned full SHA `cd45f59881b70b8612b498993a518f49425482c4`, equal to clean local `HEAD` and `origin/codex/develop-plan-to-refocus-branch-direction`. The parent must commit the review/status metadata and obtain the required narrow review of that new terminal SHA. |

## Codebase coverage map

| Area | What was traced/searched |
| --- | --- |
| Gate protocol and status | Recovery plan gate/review/push rules; status, local evidence, baseline, reproduction, measurements, golden journey and command ledger. |
| PR scope and design | Merge base/head ancestry; GitHub metadata; 801-path manifest; all 19 ticket paths, map, PRDs, ADRs and glossary/lessons entries. Ticket statuses were checked; 01-18 are resolved and 19 is historical. |
| Backend | Package/Vitest exclusions; 235 test-file inventory; routes including MCP/chat/files/workspaces/webhooks; models; Workspace domain; OpenWorkflow workflows/enqueue paths; DB schema/RLS/migrations; live sandbox/OpenCode tests. |
| UI | UI AGENTS and Storybook rules; 61 test files, 78 story files and `play` detection; Home/conversation/Workspace/files/publish routes and fixtures; added hydration characterization cases. |
| Codesearch | Package scripts, host diagnostic, Docker test lane, warmup integration, skipped glob route cases and OOM simulation. |
| Packages/examples | CLI build/test/check, CDK build/prebuild/tests, self-host example typecheck, and no-script Forge/OTEL packages. |
| Build/deployment | Root workspace scripts, six GitHub workflows, backend/UI/worker/codesearch Docker paths, Compose, Terraform infra, docs build and deployment limitations. |
| Evidence/security | 121 artifact hashes; test/story and Storybook result tables; raw JSON/JSONL/log counts; cleanup artifacts; high-risk token/JWT/private-key scans; personal host metadata search. |

## Blocking findings

None for exact remote SHA `cd45f59881b70b8612b498993a518f49425482c4` on the Standards axis. The review/status metadata commit is a later SHA and remains subject to the gate protocol's terminal-SHA review (`docs/plans/workspace-chat-recovery.md:562-580`).

## Resolved findings from `0290b161`

1. **Missing affected tests:** `apps/backend/vitest.config.ts` excludes `ingestionRetraction.integration.test.ts` and `mcp.conformance.test.ts`; the package command separately excludes RLS. Candidate `0290b161` had a separate RLS run but no record for the other two, contrary to Gate 0's “all affected builds/tests” requirement (`docs/plans/workspace-chat-recovery.md:587-592`). `cd45f598` adds a narrow inherited config and exact named-file evidence. The four retraction failures remain visible, which is acceptable for Gate 0.
2. **Five proof overclaims:** `0290b161` marked `checkout-read`, `tanstack-workspace-chat.live`, `conversation-files-routes.live`, `modelProvider`, and mixed `workspaceChatWebSocket` as proof even though owned repository/store/runtime/observability behavior is replaced or the file now contains explicit catch-and-empty characterization. This contradicted the classifier rubric in `backend-classification-review.md:7-17`. `cd45f598` conservatively reclassifies them and updates every aggregate to 207/214.
3. **Ticket status overclaim:** `0290b161` said all 19 tickets were resolved, while issue 19 says `Status: historical`. `cd45f598` now says “all 19 Git-backed Workspaces design tickets.”

## Owned later-gate follow-ups

- **Gate 1:** full typecheck/build failures; all recorded skips and missing prerequisites; OpenCode 1.3.13 vs required 1.18.18; retraction test RLS setup; CLI live eval; CI filtering and prerequisite truthfulness.
- **Gate 2:** native local-remote tip resolution, desired/active revision consistency, hydrate missing import, projection behavior, and retraction real-DB contract.
- **Gate 3:** default-branch write/push ownership and successful GitHub publish proof; the local fixture correctly does not claim GitHub App/publish coverage.
- **Gate 4:** same-conversation session/worktree reuse, transcript accumulation, restart durability, SIGTERM/listener shutdown, sandbox deletion, and the one observed navigation-directory leak. The 52 measured/manual directories were removed; `navigation-resource-cleanup.json` truthfully retains `exists: true` for one separate directory.
- **Gate 5:** Home first-message single acceptance, UI request/polling budget, usable editor interaction, authoritative file/diff updates and file persistence across restart.
- **Gate 6:** deterministic full product journey, deployment/codesearch/Storybook acceptance and deletion ledger.

## Standards and smell assessment

No remaining documented coding-standard violation was found in the focused correction. The new Vitest config is a narrow, requirement-driven reproduction fixture, so it is not speculative generality. No actionable Fowler smell remains in the changed executable helpers after documented repo rules take precedence. The large raw logs are evidence artifacts, not production modules.

The public bundle contains local username, PID, temporary-directory and absolute-path telemetry (hundreds of occurrences across raw logs). This is not a credential, no repository rule forbids it, and the user explicitly authorized publishing all Gate 0 logs to this public branch. It is therefore not a Standards or publication blocker.

## Commands and searches used

- `git rev-parse`, `git log f632772c..HEAD`, `git diff f632772c...HEAD`, focused `0290b161...cd45f598` diff, `git merge-base`, `git rev-list --count`, `git diff --numstat`, remote-tracking ref checks, and live `git ls-remote origin refs/heads/codex/develop-plan-to-refocus-branch-direction`.
- Fresh 801-file manifest generation plus `cmp`; affected-surface derivation and per-surface counts.
- Fresh PR-head test/story inventory generation plus `cmp`; TSV uniqueness/field/classification counts; independent story `play` recomputation; source inspection of proof rows with repository-owned mocks.
- `rg` over package/Vitest includes/excludes, all evidence logs for excluded test names, stale aggregate counts, cleanup claims, product-failure claims and sensitive-value patterns.
- Independent SHA-256 recomputation for all 121 manifest entries and set comparison against every archived log.
- Raw summary checks for typecheck diagnostics, Vitest totals, Storybook 347/24/0 results, 5/20 measurement splits, 25/25 oracle outcomes, session/directory counts, query counts and cleanup state.
- `bash scripts/tests/workspace-recovery-baseline.test.sh`; `python3 scripts/tests/workspace-recovery-runner.test.py`; `python3 -m py_compile` with a disposable cache; cloned fixture `git fsck --full` and tree inspection.
