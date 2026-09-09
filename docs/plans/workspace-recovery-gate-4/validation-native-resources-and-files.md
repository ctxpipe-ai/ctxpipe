# Native resource and Files checkpoint

This is an in-progress Gate 4 checkpoint, not a gate closure. It adds an opt-in
native resource contract. Production chat image, egress and provider wiring,
Railway proof, and the final ownership audit remain pending.

## Changes and proof

- Git branch and filename inputs use quoted environment arguments. A native Files
  HTTP regression with shell punctuation in a tracked filename failed because the
  old diff body was lost, then passed with exact old/current content and no
  injected marker.
- Renames use the native process/filesystem boundary without a text round trip.
  A binary HTTP rename previously deleted the source and returned a missing
  destination. The replacement preserves exact bytes. Reads propagate failures
  unless absence is confirmed. The obsolete fake-handle copy/delete
  characterization is removed.
- Native Docker create/resume/restore/fork enforce an opt-in profile: non-root
  1000:1000, 1 CPU, 1 GiB memory with no extra swap, 128 PIDs, 4 GiB storage,
  dropped capabilities, no privilege escalation, no external mounts/devices, and
  disabled container logs. Resume rejects mismatched existing containers before
  restarting them. Images declaring volumes are rejected.
- The Btrfs DinD runner preserves Docker's native snapshot/fork implementation.
  A real write stopped at 4,285,005,824 bytes with `Quota exceeded`; cgroup values
  and non-root identity were checked inside the container. The contract also
  verifies resumed/restored/forked content and rejects an insecure container.
  CI requires this runner rather than skipping the quota test.
- Two existing chat type diagnostics are resolved; backend allowances fall from
  132 to 130. Five new optional-method errors in the resource test were fixed,
  not allowed.

| Evidence | Result |
| --- | --- |
| `native-files-shell-path-red` / `native-files-shell-path-green` | Real diff regression reproduced; all 3 then-current Files tests passed |
| `native-files-binary-rename-red` / `native-files-binary-rename-green` | Real data loss reproduced; all 4 Files tests passed |
| `native-docker-resource-policy-red-endpoint` | Failed on root container identity before the native patch |
| `native-resource-files-final` | 27 tests across 4 affected files passed, 149.36 s |
| `resource-files-backend-types-fixed` | Full backend project: 130 acknowledged, 130 total, no new/stale allowances, 113.85 s |
| `native-protected-branch-current-contract` | Corrected locked-branch/permission contract passed, 10.42 s |
| Frozen offline install, Biome, shell syntax, proof policy and CI partition | Passed; 190 backend + 42 contract files, no overlap or omissions |

Raw logs, daemon details and machine metadata stay in task-local work storage.
Earlier quota attempts exposed invalid test assumptions about `df` output/error
wording and a disposer invocation mistake; these are corrected, not counted as
passing evidence. The final cleanup left no containers in the quota test daemon.

## Review disposition

Independent spec review found zero blockers in the opt-in resource contract.
Independent standards review found no newly introduced policy/runner blocker.
Files correctness review passed after removal of the obsolete characterization.

Standards review identified an inherited native `handle.fork()` intermediate-image
leak. The test explicitly cleans that artifact; this is **not** proof that the
provider owns its cleanup. Durable fork-image ownership, failed-start cleanup and
process-loss collection remain a Gate 4 blocker. Production resource wiring is
also still pending; merely enabling the profile on the current bootstrap image
would not establish complete isolation.

## Previous checkpoint CI

[CI 34319040516](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34319040516)
on 33503fd5 passed 12 jobs. The Tests job failed on one of 293 native contracts:
an obsolete automatic session-branch expectation. Locked issue 14 requires new
conversations to remain on default until an explicit branch change. Its replacement
retains the permission checks and explicitly exercises both branches. A new full
CI run is required for this checkpoint.
