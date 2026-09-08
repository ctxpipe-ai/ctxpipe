# Gate 3 nine-kind checkpoint — Standards coverage

## Pinned identity

- Base and merge-base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.
- Reviewed target: `10039ec00185b12c30aba616f6624a0abbd520f0`.
- Range commits: `e7c18bd8`, `09e34dc6`, `f7119635`, `46aaecab`, `398e5f18`, `1ced7198`, `10039ec0`.
- All repository reads used the pinned three-dot diff, log, or `git show TARGET:<path>`; the changing worktree was not used.

## Standards and review method

Reviewed pinned root/backend `AGENTS.md`, code-review and TDD/mocking skills, ADR-027/028/033, locked issues 02/10/12, the accepted Gate 3 plan/status, and the supplied evidence. Applied the complete Fowler baseline with repo overrides and skipped tooling-enforced matters. The main report distinguishes the documented preservation breach from its Duplicated Code heuristic. No product files or branches were changed.

## Complete changed surface

The range has 435 paths: 38 backend implementation TypeScript files, 17 backend test files, 366 Gate 3 evidence/review artifacts, 3 CI policy/diagnostic paths, and 11 ADR/package/config/Gate 2 artifacts.

Implementation blobs reviewed:

- Schema/models: `db/schema/workspaces.ts`; `models/{github-installation,workspace-write-jobs,workspaces}.ts`.
- Domain: `commit-subject`, `folder-map`, `hydrate-write-jobs`, `hydrate`, `knowledge-metadata`, `layout`, `link-declarations`, `linked-repository-url`, `migration-export`, `native-rename-rewrite`, `slug`, `workspace-lifecycle`, `write-broker`, `write-command`, `write-commit-files`, and `write-job-intent`.
- Admission/workflows: `openworkflow/client.ts`, `enqueue-workspace-write-commit.ts`, and the nine typed workflows for bootstrap, UI file edit, import cleanup, claims upgrade, valid-from persistence, ops folder map, link/unlink, migration export, and rename repair.
- Other runtime surfaces: model deadline handling, workspace HTTP routes, Git clone/pack/stage helpers, and native hydration fixture.
- Tests/config: all 17 changed backend tests, `package.json`, lockfile, Vitest serialization, workflow discovery, and CI contracts.

## Changed interfaces and callers traced

- **Rename command:** `previousSha` from input schema and paused payload through admission, immutable job comparison, PostgreSQL JSON payload, retry reconstruction, `acquireWorkspaceWriteRevision`, `captureGitPack(additionalShas)`, typed workflow, discovery, native contracts, and the still-present generic caller slated for later deletion.
- **Rename transform:** both immutable trees; regular Markdown mode filtering; binary/UTF-8/malformed exclusion; Git 50% candidates and restricted ambiguity checks; moved-source rebasing; rooted/relative URL resolution; mdast links/images/definitions; YAML claims; stage/path validation; commit, broker, publication, hydrate, no-op refresh, and replay.
- **Export repairs:** keyed body/metadata/claims merge, null import-key removal, declaration collision allocation and canonical URL identity, source URL credential validation, immutable `readGitFiles`, workflow serialization, public export visibility, and native export characterizations.
- **Other corrections:** nested claim aliases, folder-heading discrimination, paused-to-queued atomic ownership predicate, cron/public status observers, Git mode preservation, terminal reconciliation, and model timer cleanup.

The six unique `1ced7198` findings are corrected: keyed export content, declaration collisions/canonical identities, unsafe source credentials, null import keys, cleanup-heading false positives, and nested aliases. The new rename path meets ADR-033’s credential, immutable pack, explicit durable step, short-SQL, mapping-before-push, non-FF broker, publication, and hydration boundaries apart from the reported comment loss.

## Verification disposition

I did not rerun the reported 63 native checks, 15 export characterizations, 17 cron/ownership checks, full typecheck, policy suite, or pending CI. A small read-only `yaml` probe verified the reported alias-comment behavior. Declared pending export follow-up planning, three remaining kinds, caps/remainders, pause/protection resume, semantic conflicts, alternate writers, and legacy deletion were excluded. The command property bag remains an acknowledged optional Fowler heuristic.
