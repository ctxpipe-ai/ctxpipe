# Gate 3 semantic/model Spec coverage ledger

## Pin and sources

- Read only target `bafb805b2c16b2b9816d4bada2c4b692282c8945`, fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; enumerated the ten-commit log and full base diff, plus the delta from `cab52801`.
- Applied recovery Gate 3 (`workspace-chat-recovery.md:642-659`), locked write protocol (ticket 10), provider topology (ticket 08), ADR-033, target status, root/backend instructions, and the previous pinned Spec/Standards reports.
- No repository mutation or suite execution. One isolated `/private/tmp` native-Git probe confirmed the modify/delete provisional-tree behavior.

## Interface and caller coverage

| Surface | Pinned blobs/callers traced | Assessment |
|---|---|---|
| Durable admission | `write-job-intent.ts`, `workspace-write-jobs.ts`, `enqueue-workspace-write-commit.ts`, paused reconstruction/tip-check | Prior two defects fixed; identical fallback retry is read-only, differing captured tuple fails; semantic content schema runs before probing/persistence |
| Semantic command | `semantic-merge.ts`, `workspace-semantic-merge.ts`, `merge-tree.ts`, write-tree/pack/command/broker helpers | Clean merge unchanged; overlap structured path boundary works for ordinary content conflicts; modify/delete authorization defect reported |
| Resource lifecycle | provider selection, stable locator, create/resume/use/destroy steps, Docker patch source/runtime/types, package patch wiring | Lost-create replay is stable for Docker; resolution cleanup runs before broker push. Fargate/provider dispatch defect reported; cancellation/abandon cleanup remains declared open |
| Model transport | `getModel("high")`, OpenAI-like fetch injection, structured schema, three-attempt policy | Exact path set and size are bounded; repository content has no tools/credentials; out-of-scope response cannot stage or push |
| Extraction snapshot | DB transaction options, `loadExtractionProjectionSource`, cumulative `getCompletedKnowledgePaths`, extract workflow | One repeatable-read transaction captures source/map/cutover; omitted-object maps fold oldest-to-newest and current-Git existence remains the reuse fence |
| Production callers | typed enqueue/discovery, legacy write workflow/agent, provider selection consumers, extract/export model readers | Implemented direct path covered; automatic non-FF handoff and old provider callers remain declared migration scope |
| Fixtures/contracts/config | merge/extract native contracts, hydration/index fixture changes, Vitest/diagnostic and patch manifests | Read claimed 56-check evidence and red/green scenarios; did not rerun |

## Prior finding verification

1. **Immutable fallback — fixed.** `persistWriteJobIntent` inserts on conflict, reads the existing row, and compares workspace, kind, generation, desired SHA and captured subtype fields without changing status/owner.
2. **Paused semantic validation — fixed.** `semanticMergeContentSchema` requires previous SHA, safe unique paths and exactly one operation per path before workspace lookup or fallback persistence.
3. **Extraction identity/cutover — strengthened.** completed path maps are cumulative; source objects, maps and migration completion are read from one repeatable-read snapshot.
4. **Atomic mirror binding and earlier blockers — unchanged and still corrected.** No affected interface regressed in this delta.

## Semantic conflict reasoning

- Native Git remains authoritative for the base/current/incoming triples and retains clean merged changes.
- The structured result must contain each conflict path exactly once; unrelated, duplicate or omitted paths fail before staging.
- `resolveGitMergeTree` starts from Git’s provisional merged tree, applies only validated conflict resolutions, and resets the commit parent to the acquired current tip.
- Defect: `merged.paths` is not necessarily the union of paths the final model resolution may change. Native modify/delete leaves current content in the provisional tree, yielding no current-to-provisional diff. A model-selected deletion is therefore outside `validateGitTree`’s allowlist even though it is the exact conflict path.

## Evidence and exclusions

- Reviewed supplied green evidence descriptions: 56 checks/nine suites, 141 pre-existing type diagnostics, lost-create acknowledgement replay, out-of-scope model cleanup, and repeatable-read lock scenario. CI `34222027784` was treated as running, not passed.
- Excluded as declared work: automatic non-FF handoff; cleanup after abrupt cancellation/abandon; broader worker/replica recovery; semantic no-op corner cases; post-hydrate planner/caps; complete pause/protection handling; provider caller/default-credential migration; legacy runner deletion.
