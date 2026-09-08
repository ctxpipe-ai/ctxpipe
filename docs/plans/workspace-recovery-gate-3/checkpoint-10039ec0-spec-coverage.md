# Spec coverage — Gate 3 nine-kind checkpoint

## Identity and method

- Base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; target `10039ec00185b12c30aba616f6624a0abbd520f0`.
- Commits, oldest first: `e7c18bd8`, `09e34dc6`, `f7119635`, `46aaecab`, `398e5f18`, `1ced7198`, `10039ec0`.
- Used three-dot diff/log and only pinned `git show TARGET:path`, `git grep TARGET`, and `git ls-tree TARGET` for source. No repository mutation or heavy suite was run. One read-only YAML-library probe checked node-update behavior.
- Supplied proof: 63 combined native/HTTP/lifecycle checks pass; 15 export characterizations pass; 17 cron/ownership checks pass; full types retain exactly 143 acknowledged diagnostics; CI `34216918050` pending.

## Requirement matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| Nine explicitly registered typed workflows | Pass for implemented slice | enqueue workflow selection; discovery contract; nine workflow definitions |
| Rename command includes immutable previous SHA/current revision | Pass | rename schema; `write-command.ts`; `workspace-write-jobs.ts`; admission and paused payload reconstruction |
| Native Git 50% similarity and many-to-one ambiguity | Pass | `native-rename-rewrite.ts:32-101`; previous/current objects captured in durable pack |
| Skip binary, non-UTF-8, malformed rename candidates | Pass | mode/blob/UTF-8/front-matter filters at lines 40-60 |
| Repair all hydrated Markdown references | **Fail** | Finding 1: only `knowledge/**/*.md` is considered |
| File-relative destination semantics | **Fail** | Finding 2: `knowledge/` and `/` special cases disagree with hydrate |
| Repair as much as possible without inventing targets | **Partial** | Destination existence and ambiguity are safe; Finding 3 skips stale links after presentation edits/duplicates |
| Parsed Markdown/claim-only editing and convergence | Pass for covered syntax | mdast destination spans; YAML-node claim edits/alias detachment; moved-source replay proof |
| One commit/no-op/replay/default/relink/push uncertainty | Pass | shared acquire/stage/validate/commit/broker/publication; completed mapping; refreshed no-op loop |
| Hydrate durably queued before completion | Pass | all committing typed workflows enqueue idempotent hydrate before completed status |
| Six `1ced7198` fixes | Five pass, one residual | keyed body/unknown claim fields, basename allocation, source URL safety, null cleanup, cleanup heading, nested aliases repaired; Finding 4 is a separate optional-confidence regression; Finding 5 is linked-row failure isolation |
| Migration preserves optional claim semantics | **Fail** | Finding 4 |
| Malformed legacy link does not block export | **Fail** | Finding 5 |
| Completed-only migration result visibility/no-op cutover tip | Pass | migration JSON no-op tip and completed-status readers |
| Cron paused-to-queued binding | Pass for current correction | queued/unbound acceptance follows immutable comparisons and excludes committed/owned/bound rows |
| Post-export bootstrap/import cleanup planner | Open, declared | excluded from finding count |
| Extract ingest, connector mirror, semantic merge; caps/remainders; complete pause/protection/conflict; alternate writers/credentials; deletion | Open, declared | excluded from finding count |

## Interfaces and callers traced

- **Standards/spec:** root/backend `AGENTS.md`; code-review skill; recovery plan Gate 3; ADR-033; locked tickets 02, 03, 09, 10, 12.
- **New rename surface:** `native-rename-rewrite.ts`, typed workflow, enqueue schema/dispatch, command payload/ownership, DB JSON type, dual-SHA pack capture, workflow discovery, native contracts.
- **Rename callers:** pinned search for every `previousSha`, `rename_rewrite`, enqueue, paused-job reconstruction, cron/tip-check, hydrate remainder, and legacy generic workflow occurrence. Automatic prior-SHA planner remains absent as declared.
- **Migration corrections:** migration planner/serializer, canonical link planner/schema, migration workflow source capture, keyed merge/YAML helpers, no-op/result models, lifecycle/retry/tip-check callers, export contracts.
- **Maintenance corrections:** folder-map detection and ops workflow; alias-safe valid-from and import-key cleanup; maintenance/ops native contracts.
- **Common write path:** revision acquisition, pack restore/read, mode-preserving stage/validate/commit, broker credential/CAS/non-FF/descendant recovery, result publication, hydrate enqueue, reconciliation and admission-failure handling.
- **Product entry points:** workspace create/retry lifecycle, Files edits, linked routes, rename/slug lifecycle, tip-check cron; OpenWorkflow public queue/status; schema and model readers.
- **Proof/config:** package/lock dependency, serialized Vitest config, required contract manifest, diagnostics allowlists, status and exact checkpoint logs.

## Commands/searches

`git rev-parse`; `git log BASE..TARGET --oneline`; `git diff --stat/--name-status BASE...TARGET`; `git show TARGET:path | nl -ba`; `git grep TARGET` for `previousSha`, rename kind/workflow, migration/export/link validators, YAML/folder helpers, write ownership, hydrate and workflow registration; `git ls-tree -r TARGET` for path discovery.

## Finding count

Five correctness findings: four P1, one P2. Worst issue: the rename job ignores root and connector Markdown units that hydrate treats as canonical knowledge, leaving committed path moves with broken references.
