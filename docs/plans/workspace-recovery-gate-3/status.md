# Gate 3 — transactional write workflows

Status: in progress. Fixed starting/verified remote SHA: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d` (Gate 2 terminal, all 13 CI jobs and both terminal reviews passed).

The accepted native Git, public PostgreSQL models, OpenWorkflow, HTTP, local sandbox, subprocess/files, and third-party API fixture seams remain authorized. First vertical slice: successful bootstrap through a real workflow and bare remote, with one-commit and durable result proof. Subsequent slices cover each typed job, concurrency, replay/push uncertainty, binding/default/protection, connector writes and broker-only credentials.


## First native write slice

`bootstrap-native-worker-red` reaches the old workflow and reproduces the missing organization-context symbol. The two earlier red runs are fixture registration diagnostics: OpenWorkflow snapshots implementations when constructing a worker, so registering afterward leaves the job undiscoverable. `bootstrap-native-step-diagnostics` then exposed the incorrect import module in the first implementation; `bootstrap-native-org-context-green` passes after importing from `auth/context.ts`.

The new `workspace-write-bootstrap` workflow explicitly acquires a revision, computes the pure bootstrap files, stages/validates a native Git tree, durably records the commit, pushes from its broker step, and queues canonical hydration. It reconstructs disposable native Git directories from durable packs at each step. The real bare remote contains exactly one new commit and the unchanged original file. `bootstrap-published-replay-red/green` then proves completed job redelivery returns the recorded commit without rewriting remote history. ADR-033 records the accepted ownership and replay boundary. The workflow is now wired into production admission; remaining typed kinds and broker caller migration are pending.

`bootstrap-backend-types` checked the complete project with no new diagnostics; it failed only because the three fixed missing-symbol diagnostics remained allowed. Their exact identities are removed, shrinking backend 146→143 and the corresponding UI allowance 234→231. Further checks must cover the subsequent replay corrections.


## Bootstrap admission and relink proof

`bootstrap-production-completion-green` passes all four initial native cases (one commit, completed replay, no-op replay, production admission). The earlier production-admission green-labelled attempt failed because the test polled the prepared commit mapping before push; the corrected test waits for the public completed status.

`bootstrap-unbound-admission-red/green` proves a missing workspace is rejected without enqueueing an unbound generic write. `bootstrap-credential-relink-red/green` proves connection detachment during the external write-credential response leaves the remote unchanged; the broker now repeats the canonical binding check after credential issuance and pack restoration. Broker retries are bounded to three attempts. The pending push-uncertainty proof loses a real native Git push acknowledgement and refreshes the desired revision before retry.


`bootstrap-push-uncertainty-red/green` reproduces and fixes rejection after a refresh observes the job's own pushed commit. The passing proof has exactly one remote commit and one write-token request, a completed public job result, and a queued canonical hydrate. Completion now follows durable hydrate enqueue, so a retry cannot short-circuit an unqueued follow-up.

`file-edit-native-red/green` replaces generic admission for UI additions/deletions with `workspace-write-ui-file-edit`; the remote has exactly one requested edit commit. The command's file contents and deletion list are immutable along with its revision. `bootstrap-default-race-red/green` prevents a write to the old default after the actual remote changes during credential issuance. `bootstrap-concurrent-ownership-red` is a passing characterization despite its recorder name: concurrent deliveries already produce one completed owner, one failed delivery, and one remote commit; no fix was needed.

The required CI write contract now runs the native success/race proofs instead of the obsolete twelve-case assertion that `requireCurrentOrgId` is undefined. Only bootstrap and UI file edits are migrated so far; the remaining ten kinds, protected/paused resume, deeper restart/conflict proofs, shared Git transport cleanup, and all alternate writer migrations remain Gate 3 work. Worker discovery also requires both new workflow names.


Checkpoint validation: `typed-write-checkpoint-native` passes 11/11 tests across native write contracts and real worker discovery. `typed-write-checkpoint-types` passes the complete backend project with exactly 143 acknowledged pre-existing diagnostics and no new or stale allowances. Proof policy passes 431 test/story/config files and 27 command files after staging the deleted obsolete characterization. This is an intermediate Gate 3 checkpoint, not terminal gate acceptance.
