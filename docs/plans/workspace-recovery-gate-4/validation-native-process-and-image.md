# Native process and image checkpoint

Gate 4 remains in progress. This checkpoint fixes native transport/process
ownership and prepares the non-root chat image. Production egress, remote runner
wiring and Railway acceptance remain open.

## Behavior

- Docker create requests carry container environment values only in the JSON
  body. An HTTP forwarder to real Docker reproduced a synthetic credential in the
  request URL; the corrected native request separates query and body fields.
- Native Docker commands inherit the image/container environment and apply only
  explicit overrides. The adapter previously forced `HOME=/root`, making the
  configured non-root home unusable. Commands and resumed handles now preserve it.
- Native Docker process wait records transport completion before consumers can
  close their output iterators. Waiting after a completed kill no longer misses
  the close event. A still-running process is reported rather than treated as an
  exit with code zero.
- Native OpenCode accepts port zero, parses the complete readiness URL and uses
  its actual port. Startup failures and disposal terminate and await the process
  with bounded waits; cleanup failures preserve the original failure. The app's
  bind/close port allocator, process Set and empty disposer are removed.
- The new chat image includes pinned OpenCode 1.18.18, Git, GitHub CLI and a
  writable home/workspace for UID/GID 1000. A real native-provider run verified
  resource configuration, local Git clone, OpenCode health and process disposal.
  Production still uses the previous image until network/provider wiring is ready.

## Focused evidence

| Evidence | Result |
| --- | --- |
| `native-docker-env-url-red-http` | Synthetic credential observed in Docker create URL |
| `native-docker-env-url-green` | Request body preserved; URL contains no credential; 5.12 s |
| `native-docker-home-red` | Container HOME incorrectly replaced by `/root` |
| `native-home-url-ports-green` | Three native regressions passed in 16.43 s; two concurrent OpenCode servers pass independent health/version and teardown checks |
| `native-docker-post-kill-wait-red` | Reproduced missed process termination |
| `native-docker-wait-and-chat-green` | Process wait and real two-turn persisted chat passed in 34.07 s |
| `native-port-chat-cancellation` | Cancellation and ownership release passed in 22.24 s |
| `chat-type-fixtures` | All 19 affected fixtures passed in 4.57 s |
| `native-chat-image-final` | Non-root image, resource settings, Git, OpenCode 1.18.18 health and teardown passed in 23.95 s |

Raw logs and machine/image identifiers stay in task-local work storage. The first
HTTP transport harness required an unrelated exec-upgrade proxy and timed out;
the retained regression uses a real failed container start to isolate the create
request. Initial image proof exposed the HOME and process-wait defects above;
those failed attempts are not passing evidence.

Full backend types pass with 125 acknowledged diagnostics and no new/stale
entries (`native-process-backend-types`, 77.00 s). UI types pass with 223 and no
new/stale entries (`native-process-ui-types`, 105.81 s). The five chat-related
allowances are removed after fixing their actual types/configuration. Bounded
standards review found no material blocker in this checkpoint.

## Completed CI and follow-up

CI 34323063810 on 6ff63064 passed 11 jobs, 1,190 default backend tests and
295 of 296 contracts. Typecheck failed on the two stale UI entries already fixed
in f8bc1d16. The sole contract failure was the quota test's missing error text:
it wrote stderr onto the same full filesystem. The correction captures stderr
through the native host stream and retains the exact quota-exceeded requirement.
A new full CI run remains required after this checkpoint is pushed.

The quota diagnostic correction is pending the next full CI run. Local Docker
storage cannot currently fit another 4 GiB physical write alongside the chat
image; keep the existing passing resource evidence and run the corrected
assertion in CI rather than confusing host exhaustion with the container quota.
