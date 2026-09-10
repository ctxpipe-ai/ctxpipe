# ADR-031: Required recovery CI

**Status:** Accepted | **Date:** 2026-09-08 | **Tags:** ci, testing, recovery

## Context

The full PR 280 baseline found path-filtered TypeScript checks, excluded database
tests, optional OpenCode tests, missing test fixtures, and build scripts that ran
`tsc` with `noEmit`. A green check did not establish which product paths ran.
The accepted workspace recovery plan requires Gate 1 to make those checks
truthful before Gates 2–6 change product behavior.

## Decision

- Check every affected TypeScript project with its actual compiler configuration.
  Print all diagnostics. During recovery, acknowledge only the finite, reviewed
  file/code/message/count baselines in `scripts/ci/diagnostics`. Git history must
  show that allowances only shrink; resolved allowances must be removed.
- Run required tests with an inventory and Vitest's structured results. A
  missing file, empty suite, skip, todo, unrecognized failure, or abnormal process
  exit fails the command. Existing failures may have exact file/title/error
  allowances in `scripts/ci/failures`; they still execute and print as failures.
- Require the declared Bun and OpenCode binaries and migrated PostgreSQL using
  an application role without table ownership or RLS bypass. Scripted model
  upstreams exercise the real proxy and OpenCode process without paid requests.
- Keep named PostgreSQL, native git, local sandbox/job worktree, OpenWorkflow,
  hydration, and chat-engine contract lanes. Their assertions use real owned collaborators.
  Hydration runs its workflow for 0/1/100 files. Every write kind runs through
  OpenWorkflow and records its current pre-write failure as an explicit
  characterization; Gate 3 replaces it with successful commit/CAS/push proof.
  Gate 0's characterization classification remains explicit pending replacement
  and deletion; it does not count as proof of the replaced collaborators.
- Reject test selection modifiers, expected-failure tests, blind test retries,
  and owned collaborator substitution in proof. External SDK/network boundaries,
  output observation, and the two documented Gate 0 filesystem fixtures retain
  their existing roles.
- Build every production image without publishing it. Build backend/codesearch
  package entrypoints with Bun and check types separately. Build distributable
  CDK/CLI packages and typecheck the self-host consumer. Validate Terraform with
  its remote backend disabled and without account credentials.
  Run pnpm installation and frontend compilation under Node 22 in Docker;
  Bun remains the production service runtime. Native Linux builds stalled during
  pnpm installation under Bun, while the Node 22 CI installation completed.
- Run the tagged Storybook `workspace-golden` plays in Chromium. The
  `storybook-golden` job builds Storybook and opens each tagged story
  iframe until the play function completes. A skip, missing required
  play, or unexpected failure fails CI. Direct Playwright against a live
  backend remains optional and is not a substitute for these plays.

## Consequences

CI needs full Git history and real prerequisites. It costs more than isolated
mock suites, but distinguishes successful execution from acknowledged defects.
Allowances are temporary recovery debt, never permission to skip execution or
add regressions. Passing Gate 1 does not claim the product invariants assigned
to later gates are fixed.

## References

- [Workspace recovery plan](../../../docs/plans/workspace-chat-recovery.md)
- [Gate 0 baseline](../../../docs/plans/workspace-recovery-gate-0/baseline.md)
- [Application role and RLS](ADR-028-postgres-rls-app-role.md)
- [Bun service runtime](ADR-002-backend-service-stack-and-runtime.md)
