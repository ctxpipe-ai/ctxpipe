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


## Review corrections after e7c18bd

Intermediate checkpoint `e7c18bd854a54f7d8190c663a014c5f0158ed67e` was pushed and verified on the authorized recovery branch. CI run `34204037096` completed with 12/13 jobs passing: all builds, native codesearch, all project typechecks, lint, migrations, packages and Terraform passed. Backend tests found the existing allowed chat failure plus three assertions tied to the prior command shape / an overly strict concurrent-delivery ordering. The obsolete mock assertion requiring an unbound enqueue is removed in favor of the existing native rejection proof. The Files HTTP assertion now checks the typed payload. Concurrent replicas may either reject an active owner's duplicate or return its completed result; the contract still requires exactly one published commit and one recorded owner.

Both intermediate reviews are saved in `checkpoint-e7c18bd-{standards,spec}.md` with coverage reports. They are not Gate 3 terminal acceptance. Their duplicated-code finding prompted shared ordinary Git stage/validate/commit and broker functions; each workflow retains explicit durable steps. `shared-native-write-regression` passes 13 tests.

Commit subjects now select the fixed small model, disable streaming, and abort after five seconds before using the literal fallback. The real third-party HTTP contract reproduces the wrong tier model and missing timeout, then passes with the existing model-provider tests (23 total in `commit-subject-timeout-green`). Earlier non-escalated model red runs are local PostgreSQL permission/import diagnostics, not product failures; `commit-subject-native-runtime-red` is the actual wrong-model reproduction.

`descendant-push-recovery-red/green` proves a lost push acknowledgement can be recovered after another writer advances the branch: native reachability finds the job's commit in the current default, the immutable job SHA is retained, and canonical hydration is durably queued for the descendant. Publication now refreshes and validates the canonical revision and throws on a binding/CAS miss instead of completing without a hydrate. The two success cases use one write credential and do not push again.

`native-file-mode-red` reproduces executable/symlink conversion to ordinary files. Native staging now preserves the indexed mode, and the mode case passes in `native-file-mode-green-terminal-status-red`. That same run reproduces the public status remaining running after native retries exhaust. `terminal-native-status-green` passes the terminal-status correction and both lost-ack cases: the model reconciles a failed/canceled owning OpenWorkflow run, with org/workspace/job identity predicates, in a short SQL transaction. Step failures still awaiting native retry remain running. Admission-failure reconciliation remains outstanding.

`stale-noop-native-red/green` proves an apparent no-op against an old cached SHA is recomputed against the actual default. The workflow can refresh at most three times, never changes the immutable original command identity, and publishes one correction commit on top of the concurrent human commit. Complete replay remains a durable return.

Remaining Gate 3 scope is unchanged: ten typed kinds, semantic conflict/rebase, protected/paused admission and resume, scheduling-failure recovery, attempt/remainder bounds, deeper worker restart/replica proof, and migration/deletion of all alternate writers and broad credentials.

Proof-policy recheck after the review corrections passes 432 test/story/config files and 27 command files. The fixed-small-model HTTP contract is now included in the required write-job contract set.

`reviewed-write-regression` passes all 37 tests across the native write, small-model HTTP, Files HTTP, remaining queue characterization, and real worker-discovery suites (237 seconds). No local full-backend suite was run alongside the host services.

`reviewed-write-types` passes the complete backend typecheck (272.5 seconds) with exactly 143 acknowledged diagnostics and no new or stale allowances. Scoped Biome passes all 12 changed/new implementation and native-contract files. This remains an intermediate checkpoint; the scheduling-failure scenario and all remaining Gate 3 requirements are still active work.


## Admission and maintenance slices after 09e34dc6

Checkpoint `09e34dc65bff581b1d51bc25c0f5863dfc14fd07` was pushed and verified. Required CI was explicitly dispatched as `34206178681` because the push event was skipped.

`native-admission-failure-red/green` injects an actual PostgreSQL enqueue failure via a trigger scoped to one disposable fixture job. It reproduces both the stuck queued status and the unhandled wake-side-effect rejection. The admission path now fails only a validated unowned command with no native scheduled run, preserves the original enqueue rejection for its caller, and permits the same command/ID to be retried. The passing test has failed → queued → completed public states and one native remote commit. The trigger/function and owner connection are removed in finally.

`import-cleanup-native-red/green` migrates import-key cleanup to an explicitly registered typed workflow. It removes only the intended knowledge import key, preserves a connector source file, and publishes one commit. `claims-upgrade-native-red` proves its previous generic admission; `claims-upgrade-native-metadata-red` then reaches the new typed workflow and reproduces invalid YAML caused by the old handwritten serializer (a quoted colon becomes an invalid mapping). `claims-upgrade-native-green` passes 12 tests, including native cleanup/claims/discovery and existing maintenance transforms. YAML document updates now preserve unrelated metadata, comments and body bytes.

There are now four migrated kinds: bootstrap, UI edit, import-key cleanup and claims upgrade. In response to the duplication review, their ordinary org/log context, completed-command validation and native immutable acquisition are shared in `write-command.ts`; explicit step sequences remain in each workflow. `shared-command-native-regression` passes all 17 native write/maintenance/discovery tests after that refactor. This source is not yet checkpointed or fully typechecked; eight kinds and the remaining Gate 3 policy/transport/lifecycle requirements remain active.


`valid-from-native-red/green` migrates validity persistence as the fifth typed kind. The workflow reads each path's introducing commit through the already proven native Git history API, records only the timestamp map durably, and preserves explicit existing dates. Two controlled native commits prove literal January and February timestamps are distinct in the final files, with one maintenance commit. `five-kind-native-checkpoint` passes all 29 tests across five suites; proof policy passes 433 test/story/config and 27 command files.

CI `34206178681` at checkpoint `09e34dc6` completed 12/13 jobs successfully. The backend suite had 1474 passes and only the previously acknowledged Gate 4 chat failure. All 133 required contract assertions passed, but their process correctly failed on one unhandled TimeoutError; its reported active file was the Files HTTP contract. No failure allowance was added. `completed-subject-deadline-red` separately reproduces that an already completed model request receives a late abort from its uncleared timeout. The deadline now has an explicit owner and is cleared in finally. Native model/Files validation and the next exact-SHA CI run must confirm cleanup; do not infer that the entire CI failure is resolved merely from assertion counts. The native Zoekt health fixture remains unchanged while the timeout source is being verified.


Five-kind checkpoint validation: `completed-subject-deadline-green` passes all 18 model and Files HTTP tests after clearing completed-request timers. `five-kind-types` passes the full backend project with exactly 143 acknowledged diagnostics and no new/stale allowances (30 seconds). Scoped Biome passes 17 changed/new implementation and contract files. Seven typed kinds, automatic post-hydrate maintenance planning, remainder/attempt guards, paused/protected resume, semantic conflict/rebase, full restart/replica proof, all alternate writers/credentials, and legacy deletion remain Gate 3 work.
