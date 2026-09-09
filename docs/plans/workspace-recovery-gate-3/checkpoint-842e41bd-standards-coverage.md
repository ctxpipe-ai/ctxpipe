# Gate 3 correction — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Cumulative base/review reused: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67`
- Focused pin: `842e41bdeb68fc796d8a810a1dc17ccbf0d448e8`; merge base with `d3ba7e59` verified. One commit, 25 paths, +1,150/-178.
- Read-only pinned `git show`, `git diff`, and `git grep`; no implementation or test process.

## Standards and scope

- Reused the cumulative root/backend `AGENTS.md`, code-review and TDD/mocking guidance, ADR-027/028/033, accepted recovery plan, ownership audit, and caller ledger.
- Inspected only the correction delta: root/linked authority, metadata bytes, native authority tests, retired model APIs, and closure documentation. Nine earlier Fowler judgments were retained without rediscovery.

## Changed interfaces and callers

- `assertExtractionSource` now routes own-workspace `AGENTS.md` and linked declarations through `assertSourceClaimsOnly`. Linked capture still validates canonical path and exact parent blob first.
- Reused cumulative caller tracing: `acquireWorkspaceWriteRevision`, `refreshWorkspaceWriteRevision`, and `pushWorkspaceCommit` invoke source validation; the broker invokes it before write-token acquisition and again after credential I/O. All semantic child publication funnels through `attemptWorkspaceCommit`/that broker.
- `assertSourceClaimsOnly` handles absent/unchanged files without rewriting, rejects one-sided presence, parses both sides, ignores only `claims`, and compares body plus other YAML values. The remaining BOM defect comes from `parseSimpleFrontMatter` stripping `\uFEFF` before its no-front-matter return.
- `updateKnowledgeMetadata` now appends the original raw plain body rather than trimming its final newline and adding another. Existing front-matter delimiter/newline behavior is unchanged.
- Removed from `workspace-write-jobs.ts`: `persistLastJobAt`, `persistWriteJobIntent`, `persistWriteJobStart`, and `countWriteJobAttempts` (145 lines). Pinned searches found no remaining reference; typed `persistBoundWriteJob`/native admission and status/result APIs remain.
- Native authority cases now exercise linked URL/branch/metadata/body/canonical-path and root metadata/body/deletion against a real Git candidate and broker, including no credential/push. They do not exercise a BOM-prefixed plain root.
- Reported 25/25 authority/metadata cases, backend types 132 with zero new/stale, policy 441/27, and Biome pass were inspected as committed evidence, not rerun. Candidate CI remains pending.

## Counts

- Documented-standard violations: **1**
- Blocking findings: **1**
- New Fowler judgments: **0**
- Retained Fowler backlog: **9** — Mysterious Name (2), Repeated Switches (1), Duplicated Code (6)
