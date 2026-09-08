# Gate 3 semantic/model checkpoint — Standards coverage ledger

## Identity and method

- Base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Target: `bafb805b2c16b2b9816d4bada2c4b692282c8945`
- Confirmed target and merge base, enumerated nine commits, and reviewed `git diff BASE...TARGET`, `git log BASE..TARGET`, `git show TARGET:path`, `git grep`, and `git ls-tree`. Current-worktree product files were not used.
- Cumulative changed manifest: 590 paths — 55 backend implementation TypeScript files, 22 backend test TypeScript files, 498 Gate 3 plan/evidence files, and 15 ADR/index/package/lock/patch/prior-gate/diagnostic/contract files. Increment from `cab52801`: 68 paths.
- Standards: root and backend `AGENTS.md`; code-review skill and complete Fowler baseline; TDD skill and `mocking.md`; ADR-027, ADR-028, ADR-033; accepted recovery plan and target status. Tool-enforced cosmetics and the identified patch-context whitespace were excluded.

## Production surfaces reviewed

- Existing twelve-kind native workflow/admission/Git/broker/model/schema surface from the cumulative range, with explicit regression attention to prior findings.
- New snapshot support: `withOrgDbContext` isolation option and nested-context guard; `loadExtractionProjectionSource`; completed path-map query; extraction durable source step.
- Semantic merge: early content schema; paused and writable admission; immutable intent persistence; native merge-tree conflict parsing; conflict triples; staged resolution; model output schema/path-set validation; OpenWorkflow create/resolve/destroy steps; publication/hydration/replay.
- Provider/runtime: sandbox selection, Docker/local factories, deterministic resource locator, pinned Docker `containerName` source/runtime/type patch, 409 create recovery, model-provider fetch plumbing, backend/worker images, Compose DIND, and Railway worker variables.
- Tests/fixtures: extraction omit/reappear and PostgreSQL interleaving cases; clean and overlapping merge; invalid model output/retry/no-push; paused/running immutable command; early invalid content; Docker lost-create acknowledgement; Files readiness timeout; worker discovery and fixture model transport.

## Changed interfaces and caller tracing

- `withOrgDbContext(options.isolationLevel)`: searched all callers; only `loadExtractionProjectionSource` requests repeatable read. Nested same-org isolation is rejected, existing ordinary/idle-timeout callers preserve behavior, and the database transaction receives the option.
- `loadExtractionProjectionSource`: callers are extract-ingest and its native PostgreSQL proof. Its nested source/path/export model calls reuse one org transaction; no Git/provider/model I/O occurs inside it.
- `getCompletedKnowledgePaths`: sole production caller is the extraction snapshot. Binding filters cover workspace, generation, repository URL, default branch, connection, completion and non-null map; oldest-to-newest assignment gives later results precedence.
- `persistWriteJobIntent`: traced through its workspace-model export and `enqueueWriteJob`. Insert-or-read compares job, workspace, kind, generation, desired SHA and captured command fields without replacing status, payload, revision or workflow owner.
- `semanticMergeContentSchema`: traced from early enqueue parsing through bound workflow parsing; it rejects absent/malformed SHA, unsafe paths, duplicates, and file/delete overlap before paused persistence.
- `mergeGitFiles` / `resolveGitMergeTree`: sole production caller is semantic merge. Traced candidate commit, native `merge-tree`, NUL-delimited paths, regular UTF-8 conflict reads, clean-tree object packing, resolution staging, validation and current-tip parent restoration.
- `createMergeSandbox` / `resolveSemanticConflicts` / `destroyMergeSandbox`: traced workflow steps, local provider proof, Docker replay proof, provider detection, Compose DIND, and hosted Railway worker configuration. This trace produced finding 1.
- Docker `containerName`: only semantic merge supplies it. Source, ESM runtime and declaration are patched; fork creation remains unnamed; deterministic name/replay and destroy are covered.
- `openAILikeModelProvider` fetch: traced `getModel` chat and embedding selection, Azure's reused lowering helper, workspace chat lowering import, and provider tests. The added fetch applies to the OpenAI-like chat client without changing the separately returned fetch interface.

## Standards and smell audit

- Documented checks: explicit typed OpenWorkflow steps; immutable/durable command and Git pack ownership; one commit/current-tip parent; broker-only write credentials; publication then hydrate completion; short org SQL; RLS context; provider resource lifecycle; native Git modes/binary rejection; deployment availability; public-seam native/PostgreSQL/third-party-edge proof.
- Fowler baseline considered: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest. No new heuristic finding was retained; ADR-033 overrides a duplication/Middle-Man concern for explicit per-kind/resource steps.
- Prior blockers: cumulative maps repair omit/reappear identity; repeatable-read model repairs cutover interleaving. Both are functionally resolved. The map implementation's unbounded transaction cost is the separate P2 finding.

## Evidence and exclusions

- Read supplied evidence/status for 56 affected checks across nine suites, native PostgreSQL/Docker/model proofs, and full backend types with exactly 141 existing diagnostics. No heavyweight suite was rerun; CI `34222027784` was recorded as running.
- Excluded as explicitly unfinished: automatic non-fast-forward handoff; canceled/abandoned resource cleanup; broader restart/replica recovery; semantic no-op edges; planner/caps; pause/protection completion; provider caller migration/default credential removal; alternate writers and legacy deletion.
- This is an intermediate checkpoint review, not Gate 3 acceptance.
