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

## Six-kind checkpoint work after f7119635

Checkpoint `f7119635da09e39f853e9b6c64770924538a3006` is pushed and verified. Its required exact-SHA CI run `34208298126` passed all 13 checks, including the required backend contracts without the previous unhandled timeout. Saved CI and two independent pinned reviews are `checkpoint-f7119635-*`. Reviews found four blocking correctness issues and two refactoring suggestions; this is not terminal Gate 3 acceptance.

`folder-map-native-red/green` migrates `ops_folder_map` as the sixth typed workflow. It reads all native Git paths, preserves live user folder labels and code-only folders, removes a dead folder reference, adds the missing reference folder, preserves quoted metadata and unrelated instructions, and converges to a second-run no-op. The new helper keeps the owner's semantic heading and only rewrites its folder section.

Review corrections have native red/green evidence:

- `claims-post-write-graph-*`: after a real upgrade commit and native hydrate, predicate-less claims retain the specified Layer-1 `LINKS_TO` relationship in FalkorDB.
- `claims-metadata-native-*` and `valid-from-metadata-native-*`: mutate YAML nodes in place, preserving `generated_by`, custom fields, anchors, and claim comments; explicit dates remain unchanged.
- `claims-relative-targets-native-*`: reuse hydration's relative target resolution, deduplicate equivalent links, preserve existing equivalent claims, and complete a second run without a commit.
- `import-key-yaml-native-*`: remove complete YAML nodes, including block scalars, while preserving BOM, CRLF, other metadata, and exact body bytes.
- `markdown-hard-break-native-*`: Files writes preserve valid Markdown hard breaks; Git whitespace lint is not a content-validation gate.

The status-reconciling model operation is explicitly named `reconcileWorkspaceWriteJob`. Three maintenance workflows share the ordinary immutable Git blob reader; each keeps its durable steps explicit. Proof policy passes 433 test/story/config files and 27 command files.

Six kinds still require migration: migration export, extract ingest, connector mirror, rename rewrite, semantic merge, and link/unlink. Automatic post-hydrate maintenance planning, per-kind remainder/cap enforcement, protected/read-only pause/resume, semantic conflict recovery, alternate writer/credential removal, and legacy deletion remain outstanding. Gates 4–6 have not started.

`six-kind-review-regression` passes all 55 tests across six suites (65.8 seconds). Initial full typecheck retained all 143 known diagnostics and exposed one new test-only narrowing error: the graph proof passed a general projection state to a published-projection reader. The proof now explicitly requires an active projection before reading it; the corrected full typecheck and focused proof are recorded separately.

`six-kind-types-green` passes the full backend typecheck with exactly 143 acknowledged diagnostics and no new or stale allowances (36.7 seconds). `claims-active-projection-green` passes the strengthened native post-write graph proof. Scoped Biome and whitespace checks pass. This checkpoint is ready for another exact-SHA CI/review cycle; Gate 3 remains in progress.

## Work after 46aaecab

Checkpoint `46aaecab94c53fef0460b6e359bcadec3483b427` is pushed and verified. Required CI is run `34210009523`. Its pinned review reports are saved as `checkpoint-46aaecab-*`; prior four blockers and two heuristics are corrected. New findings remain under repair: rename API drops the desired name; folder detection can misidentify unrelated instructions; orphan/duplicate markers falsely converge; encoded folder names fail round-trip; typed predicates must not suppress permanent Markdown Layer-1 links. These are not waived.

`link-unlink-native-red/green` migrates the seventh kind. Immutable commands include link action and URL. A real Git fixture proves a same-basename declaration is preserved, the requested link gets a distinct declaration, repeating is a no-op, and unlink removes only the normalized requested URL. `seven-kind-command-regression` passes 16 native write/command/discovery tests (64.1 seconds). Five kinds still remain: migration export, extract ingest, connector mirror, rename rewrite, semantic merge. Automatic planning/caps, pause/resume, conflict resolution, alternate writers, and deletion still remain.


The six-kind checkpoint CI `34210009523` passed all 13 checks. All five unique current review findings now have native corrections: requested display names survive HTTP admission and Git hydration; folder discovery preserves unrelated traversal instructions; invalid marker pairs fail safely; encoded legal Git paths converge; typed claims coexist with permanent Markdown LINKS_TO edges. `workspace-rename-and-slug-native-green` passes all three operations contracts, and `permanent-body-link-native-green` passes graph, hydration, and maintenance checks. The two obsolete owned-mock rename assertions were replaced by the HTTP → native workflow → Git → hydration contract.

Rename fixture debugging initially used a worker in the wrong namespace, and one attempt incorrectly chained catch onto an expect.poll assertion. Those failures are not product red evidence. `workspace-rename-default-namespace-red` is the controlled regression of the actual dropped field with the correct default-namespace worker; `workspace-rename-native-completion-green` and the subsequent slug variant prove the correction. The marker test first waited on native retries; the deterministic transform now has one attempt and `folder-markers-terminal-green` proves terminal failure without changing Git.

`seven-kind-reviewed-types` found two new errors from the missing displayName JSON payload type. `seven-kind-reviewed-types-green` passes with the original 143 acknowledged diagnostics and no new/stale allowances after adding that field. No SQL schema migration is needed for a JSON payload type.

The initial combined regression exposed fixture interference: native OpenWorkflow workers claim all commands within their namespace, including definitions not registered by that test file. Concurrent default-namespace test workers delayed one another's jobs. Backend test files now run serially; explicit worker/retry/race tests keep their concurrency. No assertions, required contracts, or failure allowances were removed. The initial command also mistyped the main workflow contract path; the corrected regression explicitly selects write-workflow-native.contract.test.ts.

`seven-kind-reviewed-regression-green` passes all 53 assertions in seven suites (86.6 seconds), including the native concurrency/retry cases. Proof policy checks 435 test/story/config and 27 command files. Seven kinds are implemented; this remains an intermediate Gate 3 checkpoint.


## Eight-kind work after 398e5f18

Checkpoint `398e5f186007e603fe878afc7ce7bbe9eddf3640` is pushed and verified. Exact-SHA CI `34212392175` passes all 13 checks. The backend suite and required deterministic contracts both pass with test files serialized; their CI steps took about 469 and 291 seconds respectively, within existing runner limits. Explicit native worker-race tests remain enabled. Pinned review reports and coverage are `checkpoint-398e5f18-*`. Spec found three correctness issues; Standards found two (one overlaps Spec) and one non-blocking command-property-bag smell. Four unique correctness findings are being repaired; optional command bags will be revisited with deletion of the generic admission/intent layer.

`migration-export-native-admission-red` reproduces generic admission, and `migration-export-native-green` proves the eighth typed kind: legacy data is captured in a short durable SQL step, maps become serializable entries, immutable existing Git data is read outside SQL, and one native commit plus durable replay exports Billing. `migration-export-unchanged-native-red/green` proves unchanged content skips staging and finishes without another commit. `migration-empty-result-native-red/green` records the resolved cutover tip for an empty migration without claiming a newly created commit. `prepared-export-visibility-native-red/green` checks public readers during actual write-credential issuance: candidate SHAs stay hidden until completion. No-op export tips are stored separately in the JSON payload; committed and empty export lookup require completed status.

The first migration fixture run failed during cleanup because the new first-workspace row had a restrictive foreign key. Fixture cleanup now removes that row before deleting its workspace, and the one failed fixture organization was explicitly cleaned. That failure is not product red evidence. The log named `migration-export-noop-native-red` passed because a failed patch had not inserted the new assertion; it is not red evidence. The subsequent `migration-export-unchanged-native-red` contains the actual failing assertion.

Review corrections have native evidence:

- `link-url-validation-native-red/green` rejects synthetic credential-bearing, query-bearing, and invalid URLs at HTTP, paused admission, and native workflow schema boundaries. Declarations and immutable admission use validated canonical URLs; malformed source declarations are skipped.
- `link-case-identity-native-red/green` makes GitHub owner/repository case variants one identity. `link-case-hydration-http-green` proves duplicate declarations hydrate once and duplicate/self HTTP links return 409.
- `ambiguous-folder-instructions-native-red/green` preserves a cleanup rule beginning with a folder code span and appends a dedicated map; existing map, marker, rename, and encoded-path checks pass.
- `claims-sequence-alias-native-red` reproduces a valid top-level claims alias failure. `claims-sequence-alias-graph-green` verifies detached mutation preserves defaults and produces both expected graph edges. Its preceding green-named run failed only because the expanded fixture correctly added a second edge to an old one-edge assertion.
- `removed-anchor-alias-native-red/green` proves cleanup preserves values whose original anchor is removed with import_key.
- `yaml-block-chomping-native-red` proves the metadata serializer lost significant trailing blank lines. Extraction now retains the complete YAML payload and serialization does not trim it; its combined native validation is pending.

`eight-kind-types` and `eight-kind-review-corrections-types` each pass with exactly 143 original acknowledged diagnostics and no new/stale allowances. The latest alias-deletion and YAML boundary edits still need the next complete typecheck. Four typed kinds remain: extract ingest, connector mirror, rename rewrite, and semantic merge. Automatic post-hydrate planning, per-kind cap/remainder enforcement, read-only/protected pause/resume, conflict resolution, worker restart/replica proof, all alternate writers/credential issuance paths, and legacy deletion remain active Gate 3 work. Gates 4–6 have not started.


`yaml-block-chomping-native-green` passes eight maintenance/ops tests. `metadata-boundaries-native-green` further covers initially empty front matter and aliased validity lists while preserving the original defaults. `eight-kind-metadata-types` passes with the original 143 diagnostics and no new/stale allowances. Proof policy checks 436 test/story/config and 27 command files.

The log `link-ssh-identity-native-red` actually passed: repeated admission normalization hid an SSH trailing-slash discrepancy. `link-ssh-hydration-native-red` reproduces the discrepancy at native hydration; `link-ssh-hydration-native-green` passes after stripping slash before .git consistently. `link-http-canonical-admission-green` replaces the two obsolete owned-mock link admission assertions with real HTTP, PostgreSQL, and OpenWorkflow admission from unknown and writable access. Both persist a validated canonical URL.

`eight-kind-native-checkpoint` passes all 58 native/HTTP/discovery checks across eight suites (115.4 seconds). `eight-kind-checkpoint-types` passes the full backend with exactly 143 original acknowledged diagnostics and no new/stale allowances (32.6 seconds). Scoped Biome checks 21 files, proof policy checks 436 test/story/config and 27 command files, and whitespace validation passes. This is an intermediate checkpoint; Gate 3 is not complete.

## Nine-kind slice and eight-kind review corrections (in progress)

Checkpoint `1ced719864bceed1640842de319313c45614a983` was pushed and the remote SHA verified. CI `34214880526` passed 12/13 jobs; backend testing found five admission/raw-URL failures plus the one previously allowed Gate 4 chat failure. Four assertions were stale; updating the paused cron observer exposed a real admission transition bug, described below. The three obsolete owned-mock assertions are replaced by native export/replay, enqueue-failure and paused-link evidence. The cron contracts now inspect the typed queue using the public OpenWorkflow backend instead of a SQL query for the retired generic workflow name. No failure allowance was expanded.

The exact checkpoint has both required reviews and coverage ledgers in `checkpoint-1ced7198-{spec,standards}*.md`. Seven unique findings were reported across the axes. Six have native reproductions and fixes below. The remaining export bootstrap/import-cleanup followups are explicitly part of the still-unfinished durable post-hydrate planner; this is not terminal Gate 3 acceptance.

`rename-native-admission-red` reproduces generic admission dropping the previous SHA. The ninth typed workflow, `workspace-write-rename-rewrite`, binds that immutable SHA with the current revision and captures both native Git trees using read credentials. Native Git `--find-renames=50%` determines candidates; path-restricted native comparisons reject ambiguous many-to-one sources. The transform skips malformed, binary and non-UTF-8 documents, edits parsed Markdown destinations and claim targets, and preserves prose, code and unknown metadata. The parser is the existing pinned `mdast-util-from-markdown@2.0.3`, now a direct dependency. Unrelated peer re-resolution from the package manager was removed and the original lock graph passed frozen installation.

`rename-native-reference-green` proves one commit and durable replay. Its preceding green-named run found an invalid reference-definition fixture (missing paragraph separation), not a product parser failure. `rename-binary-safety-red/green` verifies binary exclusion and links inside moved source documents. `renamed-source-convergence-native-red/green` reproduces and fixes rebasing an already repaired link a second time; matching original link syntax and claim positions preserves user changes and makes a repeated maintenance job a no-op. Native worker discovery and required contract registration include the ninth workflow. Automatic prior-SHA capture remains planner work.

- `null-import-key-native-red/green`: cleanup removes explicitly null and empty keys, using key presence rather than value truthiness.
- `nested-claim-alias-native-red/green`: validity persistence detaches aliased claim items before adding timestamps, preserving unrelated anchored templates.
- `folder-cleanup-heading-native-red/green`: an unmarked “Folders to clean” instruction list is preserved; genuine folder-map repair still converges.
- `keyed-export-preservation-native-red/green`: export keeps existing keyed body text and unknown metadata/claim fields, appends missing imported text, and replays/converges without another commit.
- `export-link-collision-native-red` reproduces a missing declaration; `export-link-canonical-native-green` proves canonical `api-2`/`api-3` allocation and convergence. The preceding green-named run had an incorrect `.git` expectation against the established canonical URL format.
- `export-source-credentials-native-red/green`: synthetic credential-bearing legacy repository URLs are omitted from durable repository URL data and exported source metadata. Link declarations reuse validated canonical admission; recorded external source URLs are validated before export.

`rename-schema-types` and `nine-kind-first-types` both pass the full backend with exactly 143 acknowledged original diagnostics and no new/stale allowance. Final combined native/cron/type verification is pending. Three kinds remain (extract ingest, connector mirror, semantic merge), along with planner/caps/remainders, protected/read-only pause/resume, native conflict resolution, restart/replica proof, alternate writers and credential cleanup, and legacy deletion. Gates 4–6 remain unstarted.

`nine-kind-native-first` passes all 63 native/HTTP/lifecycle checks and 14/15 export characterizations. The one remaining characterization caught that preserving an existing document also retained its import key after cutover; an explicit null export marker now removes that owned field through the alias-safe metadata helper. `nine-kind-cron-export-corrections` passes export and the updated missing-export cron contract, but reproduces a real paused-job bug: cron's claim changes status to queued before native admission, while binding accepted only paused unbound rows. The bind predicate now also accepts a queued, unbound, unowned, uncommitted command after the same immutable command checks. It cannot replace a bound revision or another workflow owner. Native cron/ownership regression is running.

The final nine-kind checkpoint validates 63 native/HTTP/lifecycle checks in the combined run; the export cutover correction passes all 15 export characterizations and three native export cases in the targeted followup. `cron-paused-typed-binding-native-green` passes all 17 cron and core write ownership/race/replay checks after the admission transition fix (78.38 seconds). The valid paused-link assertion runs against public job status and the native OpenWorkflow queue, replacing its obsolete owned mock. `nine-kind-checkpoint-types` passes exactly 143 original diagnostics, no new/stale allowances; the later binding edit only changes a SQL status predicate and is covered by the native regression. Biome checks 22 changed source/config files; proof policy checks 437 test/story/config and 27 command files; whitespace checks pass. Extraction is the next slice; this remains an intermediate Gate 3 checkpoint.


### Eleven-kind checkpoint — extraction, connector mirrors, and nine-kind review repairs

The nine-kind commit `10039ec00185b12c30aba616f6624a0abbd520f0` was pushed and verified. Exact-SHA CI `34216918050` passed 12 checks; backend tests reported the existing Gate 4 chat failure plus three rename fixture commits without an author identity on Linux. Native fixture repositories now configure their own synthetic author. No global Git configuration is changed. Pinned reviews and coverage are saved as `checkpoint-10039ec0-{spec,standards}*.md`.

Extraction now has a strict native workflow, production admission, discovery, and required contract. It writes extracted knowledge separately, preserves owner content, respects completed migration cutover by omitting `import_key`, and replays/no-ops without additional commits. Read-only extraction and export remain paused without a native run. The last two obsolete owned-mock enqueue tests are replaced by these public-model/native-queue cases; their old file is deleted.

Connector mirrors now have a strict native workflow and persisted provider/connection/repository identity. Markdown, binary assets and deletions remain one commit; byte-level no-op comparison preserves encoded assets. Mirror changes are limited to the provider's managed content root and cannot replace config, escape paths, or accept malformed base64. Acquisition and the broker check the existing provider control-plane binding, including immediately after credential issuance. Existing provider sync callers are still scheduled for migration; this checkpoint does not yet eliminate their alternate GitHub commit path.

All six findings on the nine-kind checkpoint have native regression evidence:

- `rename-all-markdown-native-{red,green}`: root and connector Markdown references now repair, matching hydrated knowledge scope; agent instructions and linked declarations remain excluded.
- `rename-canonical-relative-native-{red,green}`: rename resolution uses the canonical file-relative hydration resolver, including leading slash and `knowledge/` path segments.
- `rename-label-duplicates-native-{red,green}`: moved sources repair changed labels and duplicate destinations, and a second run is a no-op.
- `rename-alias-comments-native-{red,green}`: aliased claim edits preserve both comments and the original anchored metadata. Alias materialization is shared with maintenance/export helpers.
- `export-optional-confidence-native-{red,green}`: omitted confidence remains absent instead of becoming zero.
- `export-malformed-linked-native-{red,green}`: one malformed historical linked row is skipped while valid declarations and knowledge still export.

`mirror-native-first-green` proves binary content, config preservation, deletion, replay and byte-identical no-op. Combined checkpoint validation additionally checks provider reset during credential issuance and invalid command rejection. `eleven-kind-first-types` exposed two existing diagnostic identities whose union ordering changed with imports; correcting the old schema fixture's invalid `sourceType: repository` to the supported `git` removes those two allowances. `eleven-kind-checkpoint-types` passes 141 existing diagnostics and no new or stale allowances.

Semantic merge, durable post-hydrate planning and bounded remainder retries, protection/pause/resume completion, provider caller migration, alternate credential/default writer removal, and superseded runner deletion remain Gate 3 work. This is an intermediate checkpoint, not gate acceptance.

`eleven-kind-native-checkpoint` passes 48 tests across nine native/characterization/discovery suites (118.98 seconds), including mirror binding reset and invalid-command admission. Scoped Biome checks 27 files, proof policy checks 438 test/story/config and 27 command files, and whitespace validation passes.

### Twelve registered kinds — clean native rebase and eleven-kind review fixes

Eleven-kind checkpoint `07c6459cc260a5be65183ab3cc1d485815d0fb5b` is pushed and verified; CI `34218496795` passed 12 jobs while the test job was still running at this checkpoint. Its pinned review reports and coverage are `checkpoint-07c6459c-{spec,standards}*.md`. Both axes verified the six nine-kind repairs. Three new correctness findings and one naming heuristic are addressed here.

- Connector binding readers now return the repository URL from their existing joined SQL statement. The broker compares the complete provider/repository tuple from that single snapshot, removing its second separately committed repository read. `mirror-complete-binding-native-red` exposes the missing complete tuple; `mirror-complete-binding-native-green` passes both the tuple and the native reset-during-credential-issuance barrier. All four providers use the same complete reader contract.
- Mirror content is parsed before write-status branching. Read-only admission retains provider identity, binary encoding and deletions. `mirror-paused-binding-native-{red,green}` reproduces and repairs source loss and proves invalid managed paths create no paused job or workflow.
- Export and extraction record their object-to-path assignments as durable job-result metadata. Only completed results with matching generation, repository URL, connection and default branch are reusable, and the target must still exist in the acquired Git tree. `extract-path-identity-native-red` reproduces extra commits at both normal/collision and imported/collision paths; the green run passes four extraction and three export cases. `export-cleanup-extract-native-green` also proves migration followed by import-key cleanup and identical extraction preserves a non-preferred path with no third commit. Git remains the content authority; ADR-033 records this distinction.
- Shared helpers are named `loadKnowledgeProjectionSource` and `planKnowledgeProjection`, and extraction uses a `load-extracted-knowledge` step. Migration-specific cutover policy remains in the individual workflows.

`workspace-write-semantic-merge` is registered and admitted with an immutable previous SHA and captured file/deletion command. Its initial transform uses native Git three-way merge to rebase clean changes onto the canonical current tip, then commits with that tip as its sole parent. Native proof preserves a human edit and job edit in the same file plus deletion, publishes one commit, replays the result and converges on an unchanged second job. `merge-native-admission-red` proves the old generic admission; `merge-native-clean-rebase-green` passes. `merge-native-first-green` failed because the human fixture accidentally staged its sibling bare repository and logs with `git add .`; the corrected fixture stages only its intended file. This was a fixture error, not a product failure.

All twelve kinds now have explicit native registrations. Semantic overlap/model resolution and automatic conflict handoff are still unfinished; clean merge currently rejects overlapping changes. Provider sandbox create/use/destroy remains to be implemented as explicit OpenWorkflow resource steps per the recovery plan, rather than the old shared registry. Durable post-hydrate planning/caps, pause/resume completion, provider caller migration, alternate writer/credential elimination and legacy runner deletion remain required before Gate 3 can close.

`twelve-kind-native-checkpoint` passes 35 checks across seven affected native/characterization/discovery suites (47.61 seconds). `twelve-kind-initial-types` found two stale generic-helper type dependencies on the entire projection plan; narrowing that helper to the fields it accepts avoids changing its old tests or adding allowances. `twelve-kind-checkpoint-types` passes all 141 remaining acknowledged diagnostics with no new/stale allowance. Scoped Biome checks 25 files (one existing non-null assertion warning in an untouched Linear hunk); proof policy checks 439 test/story/config and 27 command files; whitespace validation passes. This is an intermediate checkpoint, not Gate 3 completion.


### Semantic model/resource slice and twelve-kind review corrections

Checkpoint `cab528013bb3e49ddfc05d419984f03494d6579d` is pushed and verified, with both pinned review reports and coverage ledgers in `checkpoint-cab52801-{spec,standards}*.md`. Four review findings now have native reproductions and fixes:

- `extract-omitted-identity-native-{red,green}` exercises assign, omit, complete and reappear at both normal and imported paths with same-name collisions. Completed binding-scoped path maps are folded cumulatively; returning objects reuse their existing Git files without a duplicate commit.
- `extract-cutover-snapshot-native-{red,green}` holds a real PostgreSQL claims-table lock after the objects read, completes an export from another transaction, then releases the read. The extraction model now captures sources, path metadata and cutover together in a short repeatable-read transaction. The subsequent snapshot sees the completed export and its path map together.
- `paused-command-immutable-native-{red,green}` proves fallback admission cannot replace captured files or pause an existing running owner. Insert-or-compare preserves identical retries without any row mutation, rejects a different tuple, and stops admission on persistence failure.
- `semantic-paused-validation-native-{red,green}` rejects missing/invalid previous SHA, traversal/Git-internal paths and duplicate or conflicting path operations before creating a paused command. The same content schema validates native writable admission and normalizes absent arrays.

Native three-way merges now return text conflict triples rather than failing on Git's conflict exit status. Explicit OpenWorkflow resource steps invoke a structured model against provider files, validate the exact conflict-path set, preserve the native clean merged tree and remove the provider resource before brokered push. Binary and non-regular-file conflicts fail without lossy conversion. `merge-overlap-native-red` reproduces the missing operation; two initial green-named attempts exposed model transport/structured-output incompatibility. The final `merge-overlap-native-transport-green` passes; `merge-model-resource-native-proof` additionally proves rejected out-of-scope output retries three times, preserves the human branch, never reaches push and leaves no local resource.

`merge-docker-create-replay-native-{red,green}` reproduces duplicate Docker allocation after a lost create acknowledgement and verifies stable native resource replay preserves the existing file. The narrow pinned `@tanstack/ai-sandbox-docker@0.3.2` patch adds a native container-name option and concurrent-create recovery; source, runtime and types are patched together. Existing package resolutions are unchanged, and `native-docker-patch-install.log` records a successful offline frozen install. Abrupt cancellation cleanup, broader worker-loss/replica proof and cleanup after abandoned native runs remain open.

Eleven-kind CI `34218496795` finished with 12 jobs passing; all 159 deterministic assertions passed but the test process correctly failed on an unhandled readiness timeout associated with Files save. `files-timeout-native-green` passes the exact Files HTTP save after readiness consumes its response and clears its timeout. Full CI must confirm the process-level fix; no exception was added.

Automatic non-fast-forward handoff, semantic no-op edge cases, durable post-hydrate planning/caps, protection/pause/resume completion, all provider callers and default-write credential paths, and legacy deletion remain required Gate 3 work. Gates 4–6 have not started. This checkpoint is not gate acceptance.


`semantic-model-native-checkpoint` passes all 56 checks across nine affected native/provider/discovery suites (146.27 seconds). `semantic-model-checkpoint-types` passes the full backend with exactly 141 existing diagnostics and no new/stale allowances. Scoped Biome, proof policy (439 test/story/config plus 27 commands), frozen dependency installation and whitespace checks pass. Broader backend coverage remains on CI.

Checkpoint `cab528013bb3e49ddfc05d419984f03494d6579d` CI `34220331333` finished with all 13 jobs successful; exact results are in `checkpoint-cab52801-ci.json`. This verifies that checkpoint only, not the following model/resource changes or Gate 3 completion.

The staged whitespace check additionally flagged one Markdown hard-break space in the copied review and unified patch context whitespace. The Markdown is normalized in the next checkpoint; patch-context whitespace is required for an applicable unified diff and is excluded from source whitespace checks.


### Native semantic child handoff and no-op corrections

All eleven mechanical workflows now use a durable native child workflow when the broker observes an advanced default tip. The child receives the exact captured Git delta, original parent SHA and refreshed workspace binding; connector mirrors retain their provider binding and managed-path constraints. The parent completes with the child's actual published commit or no-op result. A single native worker can suspend the parent and execute its child without starvation.

- `files-semantic-handoff-native-{red,green}` proves a concurrent human edit and a Files edit both survive in one published successor commit, one native child and a replayable parent result.
- `mirror-semantic-handoff-native-red` reproduced missing handoff. The first green attempt passed the normal case but failed the reset case because the fixture attempted its reset on a cached second credential issuance. Moving the reset into the actual credential boundary fixed that fixture. The next green-named run accepted a timeout and therefore was not terminal-failure proof. `mirror-semantic-handoff-native-terminal` tightened the assertion and failed; limiting semantic acquisition to three native step attempts yields `mirror-semantic-handoff-native-terminal-green`, which proves terminal child and parent failures with the binding error and no publication.
- `semantic-modify-delete-native-{red,green}` covers all four current-delete/incoming-delete and keep/delete resolutions. Native conflict paths now join the allowlist even when Git's provisional tree matches current. The final validated tree may legitimately be unchanged; revalidation records a replayable no-op without an empty commit. All four cases pass.
- `merge-provider-discovery-native-{red,green}` uses an absent native Docker socket and real local provider. A bounded native Docker client probe now selects local process when no daemon is reachable; an explicit Docker lock still fails. Dockerode was already transitive and is now a direct pinned dependency. Frozen offline installation passes; unrelated lockfile re-resolution was discarded. Railway and sbx capability completion remain outstanding.
- `export-semantic-no-op-native-race-red` reproduces an unpublished candidate preventing export cutover when concurrent human work already contains the export. Two earlier attempts were invalid fixtures: initial hydration erased the legacy linked-repository setup before export. The corrected fixture cancels that unrelated queued hydration. `export-semantic-no-op-native-green` proves atomic removal of the matching unpublished candidate, completed cutover at the current tip, durable hydrate enqueue, and no extra commit.

The exact `bafb805b` Spec and Standards reports are retained with coverage ledgers. The modify/delete and forced-Docker findings are addressed for Docker/local execution. Railway provider support and the unbounded historical path-map fold remain open. Actual post-admission Git CAS races, repeated semantic races, cancellation/abandoned resource cleanup, native worker-loss proof, post-hydrate planning/caps, pause/resume, provider caller migration, alternate writer removal and legacy deletion still prevent Gate 3 completion. Gates 4–6 have not started.

`semantic-handoff-native-checkpoint` passes all 58 native checks across nine affected suites (214.96 seconds). `semantic-handoff-final-types` passes the full backend with exactly 141 acknowledged existing diagnostics and no new/stale allowances. Scoped Biome checks 22 source files; proof policy checks 439 test/story/config and 27 command files. Frozen offline dependency installation and whitespace validation pass. No named semantic Docker resources remain after the proof. This is an intermediate checkpoint, not Gate 3 acceptance.
