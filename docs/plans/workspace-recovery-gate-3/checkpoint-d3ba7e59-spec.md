# Gate 3 cumulative closure — Spec review

Pinned target: `d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67`; fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`.

## Finding

**[P1] Superseded write-intent/runner mutation APIs remain exported.** [`workspace-write-jobs.ts:34-41,61-160`](apps/backend/src/models/workspace-write-jobs.ts) still exports `persistLastJobAt`, `persistWriteJobIntent`, and `persistWriteJobStart`. At the fixed base, the deleted generic admission/workflow called these functions; at the candidate, pinned `git grep` finds no caller, but `models/workspaces.ts` still wildcard-re-exports them. Two can create or overwrite a `workspace_write_jobs` row without a typed OpenWorkflow owner; the third mutates the retired shared-job activity signal. This leaves precisely the old lifecycle surface that Gate 3 requires removing: **“Delete superseded write-intent, runner, and duplicate workflow choreography.”** ([recovery plan, line 651](docs/plans/workspace-chat-recovery.md)). Delete these three exports (and the likewise unreferenced `countWriteJobAttempts` helper at lines 233–255 if it has no retained migration role) before closure.

## Assessment

No other Spec blocker was found. The pinned ownership search confirms only `write-broker.ts` can push the default branch; conversation publication is restricted to a checked session branch, and GitHub API writes are checked configuration feature-branch flows. All twelve write concerns select typed workflows. The F increment otherwise preserves linked-source authority/body/metadata, canonicalizes Notion/Confluence config identity, and removes the shared job sandbox from Files status.

Prior A–E reviews remain applicable with their corrections present. Full closure CI is still pending, so this review does **not** call Gate 3 closed.

**Count:** 1 P1 Spec finding.
