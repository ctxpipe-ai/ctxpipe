# Branch and run ownership checkpoint

The review of 39aa42a7 found cold reconstruction could discard published session content and caller-supplied run IDs could alias another conversation.

Cold native setup now restores the recorded remote branch if it exists. New conversations and deleted branches land on the captured default revision, without recreating the deleted ref. Warm worktrees remain untouched. Prepare no longer writes branch metadata, so it cannot overwrite a concurrent explicit publication. Commit permissions read current HEAD from the stock SandboxCapability. Files status exposes current HEAD for UI branch labels and links; status/diff use the captured default branch rather than another GitHub lookup.

The Postgres RunStore rejects cross-thread run IDs before and after insertion. Native persistence marks a run owned only after createOrResume succeeds, so a rejection cannot fail or abort the original run through terminal hooks.

Evidence is retained locally. The focused six-file regression passed 42/42. The native HTTP collision initially demonstrated terminal-hook corruption and passes with the package patch. Native cold reconstruction covers published content, warm unsaved bytes, deleted-ref fallback, current-branch status, and commit denial on default. The affected final Files/status group passed 26/26, with no new backend or UI type diagnostics (132 and 225 acknowledged, respectively). The restored branch also retains its remote-tracking ref so status reports it as published.

Full CI 34309893273 passed all 13 jobs on the prior checkpoint. A new full run is reserved for the next coherent milestone. Shared base snapshots, provider support, cleanup, and the final Gate 4 audit remain open.

Retained Files/policy/runtime unit checks also pass. Two mocked status checks were retired in favor of the native HTTP status proof. Detailed logs and machine metadata are intentionally local only.
