# Gate 3 G3-C correction / G3-D milestone — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed cumulative base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed increment: `ce00e052b18bceda71909afde37443070b03f5a8..dc7c51e77441d69ead16602f6263624964136dd9` (one commit, 36 paths, +5,908/-21; one production workflow, six test files, contracts/ADR/status, prior reports, and evidence).
- Pin and fixed merge base verified. Used pinned `git diff`, `git log`, `git show`, and searches; ignored the moving worktree and did not run tests.

## Sources and boundaries

- Root/backend `AGENTS.md`, code-review and TDD/mocking skills, ADR-027/033, and accepted Gate 3 remaining/status ledger.
- Focus: G3-C corrections and G3-D acceptance seams/direct callers. G3-E–G and tooling-enforced issues excluded. Nine earlier Fowler judgments retained without re-investigation.

## Changed-surface and caller ledger

- **C completed replay:** traced unborn input → `persistUnbornBootstrapJob` → `claim-unborn-command` → adopted-revision marker → completed-result reconstruction. The former unconditional null-SHA throw is now gated on absence of `payload.revision`; valid adopted no-op returns the standard no-change result, while an impossible uninitialized completed root remains rejected.
- **C subject durability:** traced generated subject from the explicit `commit-subject-unborn` step into deterministic `commitUnbornGitTree`; commit timestamp remains `run.createdAt`. Native assertion checks the generated subject.
- **C first-writer lifecycle:** traced `pushUnbornWorkspaceCommit` initialized result → exact-candidate adoption → ordinary acquisition/transform/no-op or write path. The newly satisfied fixture supplies both bootstrap files and verifies one human root plus no-op replay. It does not verify hydration or active projection, exposing the reported missing no-op hydration at `workspace-bootstrap.ts:329-343` versus commit hydration at `:404-419`.
- **D full producer proof:** inspected `repository-producer-native.contract.test.ts` end to end: isolated Git config and environment restoration; GitHub/model HTTP substitution; real production enqueue and owner/orchestrator/producer/index/extract workflow registrations; four-worker execution; native source/destination Git; emitted instruction claim; exactly one write commit; and request-fenced ready/source SHA assertion. Owned modules are not mocked. Cleanup stops worker/backend, removes connection bindings, restores environment, closes MSW, and removes temporary files.
- **D stale-source race:** traced real `/index/clone-checkout` proxy hold for the old SHA, newer native index/readiness publication, release and completion of the old run, then ordinary file/lexical reads at the new SHA and captured graph/file/search reads at the old SHA. Proxy URL and server are restored in `finally`.
- **Fixture/CI corrections:** inspected Linear, Notion, and Confluence fixture namespace changes to production `default`; required contracts now include the producer proof. ADR-033/status/remaining accurately describe C/D evidence and keep E–G open. Reported C 8 cases, D 3 native cases, connector 10, types 132, and policy 442/27 were not rerun.

## Counts

- Documented-standard violations: **1**
- Blocking findings: **1**
- New Fowler heuristic judgments: **0**
- Fowler backlog retained: **9**
