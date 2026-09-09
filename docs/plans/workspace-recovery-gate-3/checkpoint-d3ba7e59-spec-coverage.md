# Gate 3 closure Spec coverage — `d3ba7e59`

## Review boundary

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed cumulative base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Pinned target: `d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67`
- Increment: `f95422b8c35620246ddbb884c2c6e82a5b5f64a7..d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67`
- Commit: `d3ba7e59 Gate 3: close write ownership audit and retire shared job allocation`
- All source reads used pinned `git show`, `git diff`, and `git grep`. No repository file was edited and no test/native process was run.
- Historical native logs were not reread. Earlier pinned review ledgers supplied already-verified A–E coverage.

## Authoritative requirements

- `docs/plans/workspace-chat-recovery.md:642-659`: one typed OpenWorkflow per job, explicit durable steps, broker-only push credentials, native Git, retry/conflict proof, deletion of superseded choreography, and no other default pusher.
- Locked ticket 10: default branch (43–48), semantic non-FF handling (52–60, 68–82), typed concerns/loop guard (94–110), broker credentials and lost-ACK hydration (112–130).
- ADR-033: native replacement decision and credential boundary (7–28), extraction/source ownership (40–59), and final retirement note (61).

## Cumulative acceptance trace

| Family | Pinned implementation/evidence reused | Assessment |
|---|---|---|
| G3-A native ownership | Workspace job name/version/namespace checks in `workspace-write-jobs.ts`; connector and repository owner activation/projection/backfill; typed enqueue paths | Earlier wrong-owner defects remain corrected. |
| G3-B retry/resume | Persisted semantic handoff, exact candidate/delta, same parent job identity, three-race bound, paused legacy SHA adoption | Earlier lost-reply/two-tip and paused replay findings remain corrected. |
| G3-C unborn repository | Dedicated unborn binding, native parentless commit, broker push, human-first-writer adoption, hydration before completion | Earlier subject, adopted replay, and missing-hydration findings remain corrected. |
| G3-D extraction | Real repository owner/index/root/model/captured typed publication; immutable source index/JWT; current request and source fences; bounded roots/output; canonical retraction | Earlier source/readiness/evidence/body and declaration findings remain corrected. |
| G3-E allocation loss | Durable provider plan, stable Docker identity, pre-allocation expiry cleanup, process-loss recovery, Bun 1.4.2 floor | Prior f954 source review found no blocker. |
| G3-F ownership/retirement | Repo-wide push/credential enumeration; linked declaration correction; config identity correction; generic runner, graph writer, and shared job sandbox removal | One residual public generic lifecycle API finding remains. |

## Typed write-owner enumeration

`enqueue-workspace-write-commit.ts:168-460` selects only explicit workflows for all twelve concerns:

1. bootstrap
2. UI file edit
3. migration export
4. import-key cleanup
5. claims upgrade
6. valid-from persistence
7. ops folder map
8. link/unlink
9. rename rewrite
10. extract ingest
11. connector mirror
12. semantic merge

Pinned workflow search confirms each has a `workspace-write-*` definition. Every native commit site in these workflows uses `commitGitTree`/`commitUnbornGitTree`; every workflow commit path has `generateCommitSubject`. Mechanical races enter `captureSemanticHandoff` and the semantic child under the same job row.

The only other `workspace_write_jobs` insertion is `reserveHydrateWrites`, which creates bounded paused reservations consumed by typed admission. No product caller directly inserts a second executing owner.

## Default-branch push and credential audit

Production searches covered `apps/**`, `packages/**`, and `scripts/**`, excluding tests/docs.

| Mutation/credential site | Caller/scope result |
|---|---|
| `domain/workspaces/write-broker.ts:74-181` | Sole existing-repository default push. Binding, actual default, source/config authority, writability and tip are rechecked around repository-scoped token issuance; native push is non-force. |
| `write-broker.ts:407-548` | Sole unborn-default push. Same binding/actual-default/token boundary; concurrent initialization is adopted. |
| `conversation-publish.ts:217-284` | Gets a write token only inside backend publication; checks actual default and pushes an explicit session ref with force-with-lease. |
| `installation-write-client.ts:295-461` | `commitFiles` has no runtime caller except internal configuration-PR creation. `assertConfigBranch` checks current default before object creation and ref update. Notion, Confluence and Linear callers all create feature-branch PRs. |
| `github-mcp-config-pr.ts:102-145,545-579,631-653` | Repository-scoped contents/PR token; new feature ref is checked against current default, and default is rechecked before each contents write. |
| `github-installation.ts:902-923` | `getRepoWriteCloneToken` has exactly two runtime callers: broker and conversation publication. Other Git helpers request read scope; API write callers above request feature-branch configuration scope. |

Searches for native `push`, Octokit Git/ref/content mutations, force-with-lease, and write permission issuance found no other production writer. Hydration, connectors, extraction graph, migration export, webhooks and sandbox code do not push default directly.

## Incremental F review

### Linked repository claims

- `extraction-source.ts:17-115` captures the first canonical declaration and exact blob at the parent revision.
- Candidate validation requires the same canonical path and compares parsed non-claim metadata plus body; URL, branch and customer fields cannot change.
- `workspace-extract-ingest.ts:123-148` admits only the captured linked declaration among repository declarations.
- Broker acquisition/no-op/push/semantic paths all carry the immutable extraction identity.
- Inspected focused contracts cover prior missing outgoing claim, source removal/restart, URL/branch/metadata/body changes and an earlier duplicate canonical path.

### Connector config identity

- Notion uses sorted canonical `renderNotionConfigYaml`.
- Confluence uses sorted spaces and page IDs and normalizes empty/null all-page selection through `confluenceSpaceSelection`.
- The content idempotency key includes the monotonic generation, so equivalent reorderings reuse one owner while A–B–A remains three distinct generations.
- Existing Linear scope parsing already sorts its comparable rows.

### Retired lifecycle and Files

- Generic `workspace-write-commit`, write runner/agent/commit-files abstractions, extraction DB/graph writer, and obsolete mock suites are deleted in the cumulative diff.
- The F increment removes `ensureJobSandbox`/`createTanstackJobSandbox` and associated mock tests.
- `workspace-files-routes.ts:380-386` reports the immutable published revision as clean and no longer reads the retired job sandbox.
- Conversation handle adaptation and persisted pre-upgrade resource destruction remain explicitly assigned to Gate 4.
- Pinned `git grep` finds no runtime caller of `registerWorkspaceSandbox` or `getJobSandbox`; registry retention is cleanup/compatibility scope.
- **Residual blocker:** `workspace-write-jobs.ts:34-160` retains three exported mutators called only by the deleted generic admission/runner at the fixed base. No candidate caller remains. `countWriteJobAttempts` at 233–255 is also unreferenced.

## Proof and exclusions

- Source inspected the claimed regression tests and test structure without rerunning them.
- Reported evidence: linked source 6 + authority 7, Files 19, connector finalization 45, types 132/no new, policy 441/27.
- Full closure CI is pending and therefore not accepted by this review.
- Gate 4 conversation-handle replacement and old-resource deletion, and Gates 5–6, were excluded as later-gate scope.

## Findings

- P1: 1
- Other Spec blockers: 0
- Gate 3 closure status from this axis: blocked by residual retirement plus pending full CI.
