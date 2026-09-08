# Gate 3 five-kind checkpoint — Standards coverage

## Pinned identity

- Base and merge-base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.
- Reviewed commit: `f7119635da09e39f853e9b6c64770924538a3006`.
- Commits: `e7c18bd8`, `09e34dc6`, `f7119635`.
- Sources and diff were read through `git show <checkpoint>:<path>` and `git diff <base>...<checkpoint>`; later worktree edits were excluded.

## Standards sources

- Root `AGENTS.md`; `apps/backend/AGENTS.md`.
- `.agents/skills/code-review/SKILL.md` and its full smell baseline.
- `.agents/skills/tdd/SKILL.md`; `.agents/skills/tdd/mocking.md`.
- ADR-027, ADR-028, ADR-030, ADR-032, ADR-033.
- `docs/plans/workspace-recovery-gate-3/status.md` and the accepted recovery-plan constraints recorded by ADR/status.

## Reviewed scope

- Admission, immutable command/owner persistence, enqueue-failure recovery, terminal run reconciliation, and OpenWorkflow wake handling.
- Bootstrap, UI file edit, import-key cleanup, claims upgrade, and valid-from persistence workflows, registration/discovery, durable step inputs/outputs, replay/no-op paths, publication/hydration ordering, and model-subject deadline cleanup.
- Shared write-command, broker, credential, native pack/tree/staging/validation/commit helpers; executable and symlink modes; YAML transforms and introducing-timestamp history.
- Contract/unit seams, fixture changes, required-contract registration, checkpoint logs/status, and supplied evidence: 29 focused tests and full backend typecheck with exactly 143 acknowledged diagnostics. No heavy suite was rerun.

## Exclusions and smell disposition

- Did not report the seven unmigrated kinds, automatic scheduling/remainder guards, semantic rebase, protected/paused resume, alternate writers, or legacy deletion; they are explicitly pending.
- Examined all baseline smells. ADR-033's required explicit per-workflow durable sequence overrides a generic complaint about protocol repetition; finding 3 is limited to the ordinary Git file-read shape that ADR-033 explicitly permits sharing. Tooling-enforced formatting/type issues were skipped.
