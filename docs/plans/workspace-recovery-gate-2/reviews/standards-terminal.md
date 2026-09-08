# Gate 2 standards review — third pass

Reviewed exact range `d87858354a783a9fd95c46785208c9b699a45e3b...bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`, including changed interfaces, repository-wide callers, and old/parallel implementations. Both refs resolve, the remote matches the candidate, the three-dot diff is non-empty, and the commit list is non-empty. **Gate 2 code-standards result: PASS — zero blocking findings.**

## Blocking documented-standard violations

None.

The second-pass blockers are closed. Cron admission now consumes `ProjectionState` and retries any incomplete derived store (`apps/backend/src/domain/workspaces/tip-resolve.ts:10-31`), with same-SHA branch/revision proof in `index-workflow.contract.test.ts:592-641`. Test-only partial-identity helpers and delegation-only Files wrappers were deleted. The required chat, Files, and search contracts are split by observable behavior. This satisfies ADR-032’s complete-revision rules (`.ai/memory/decisions/ADR-032-workspace-revision-projection-identity.md:11-21`) and the public-seam/one-slice rules (`.agents/skills/tdd/SKILL.md:14-37`; `tests.md:19-23,38-45`).

The third pass found and the final candidate fixes two further ownership/portability defects: `shared/workspace-checkout.ts:1-21` is now the only production owner of both checkout-key base/prefix formatting, including the SQL expression at `apps/backend/src/models/workspaces.ts:395-403`; native Git selects SHA-1/SHA-256 repository format after full-hash validation at `apps/backend/src/services/git/clone-tree.ts:103-145`. Hydrate’s durable input is now a strict complete `WorkspaceRevision`, revalidated at worker execution (`workspace-hydrate.ts:42-52,84-114`), so persisted primitive jobs cannot rebind to current branch/connection state.

## Judgment smells

No actionable smell survives the full baseline. The prior Duplicated Code and Middle Man findings were removed; the repeated codesearch error-body shape was also consolidated in `codesearchClient.ts:267-280`. Remaining migration primitives are explicitly temporary under ADR-032 and Gates 3–6.

Recorded proof is green for 130 required cases/18 files with zero skips or allowances, all seven typecheck projects, policy/lint/CI-command checks, native Linux packaging (173 Node + 42 Bun), native SHA-256 Git, and Kubernetes memory/cleanup (5,230,137,344 bytes peak). Exact-SHA CI is dispatched and remains the only pending acceptance evidence; it is not a code-standards blocker.
