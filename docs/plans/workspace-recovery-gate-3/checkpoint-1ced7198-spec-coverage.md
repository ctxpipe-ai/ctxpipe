# Spec coverage — Gate 3 eight-kind checkpoint

## Review identity

- Base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Target: `1ced719864bceed1640842de319313c45614a983`
- Range: `git diff bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...1ced719864bceed1640842de319313c45614a983`
- Commits: `e7c18bd8`, `09e34dc6`, `f7119635`, `46aaecab`, `398e5f18`, `1ced7198` (oldest to newest).
- All repository reads used `git show TARGET:path`, `git grep TARGET`, `git diff BASE...TARGET`, or `git ls-tree TARGET`; the moving checkout was not used as source.
- Review was read-only. I did not run heavy tests. Supplied evidence: 58 native/HTTP/discovery checks pass; full types retain exactly 143 acknowledged diagnostics; proof policy passes; CI `34214880526` was pending in the handoff.

## Requirement matrix

| Requirement | Result | Pinned evidence |
| --- | --- | --- |
| Eight typed OpenWorkflow kinds and explicit native steps | Pass for implemented slice | enqueue map; `workspace-{bootstrap,file-edit,import-key-cleanup,claims-upgrade,valid-from-persist,ops-folder-map,link-unlink,migration-export}.ts`; discovery contract |
| Immutable command/replay ownership | Pass | `write-command.ts:55-82`; `workspace-write-jobs.ts:365-463`; migration source is captured by durable `load-legacy-source` step |
| At most one commit/no-op/default/relink fences | Pass for reviewed flows | common acquire/broker/publish helpers; migration `confirm-no-op` refresh loop and one commit step |
| Candidate before push but public only after publication | Pass | prepared commit stored first; `getWriteJobCommitSha` and migration readers require completed status |
| Lost acknowledgement/descendant recovery and native non-FF | Pass by source plus supplied contracts | `write-broker.ts`, native pack ancestry and push helpers, broker-only write credentials |
| Hydrate queued before command completion | Pass | migration real/no-op paths enqueue idempotent hydrate before completed persistence |
| Migration mechanical partition and temporal claim export | Pass | `workspace-export.ts`, `migration-export.ts`; active claims only; cross-workspace claims skipped; confidence/windows/source serialized |
| Existing `import_key` conflict merge | **Fail** | Finding 1: keyed occupant body/front matter replaced |
| Every linked remote receives one declaration | **Fail** | Finding 2: occupied basename is skipped |
| No secrets in Git | **Fail** | Finding 3: legacy link/source URLs bypass canonical validator |
| Folder-map preserves unrelated instructions | **Fail** | Finding 4: one-item “folder” instruction is claimed |
| YAML aliases/anchors/body bytes survive targeted edits | Partial | Root sequence aliases, removed anchors, BOM/CRLF/chomping fixed; Finding 5 remains for aliased sequence items |
| GitHub case/SSH canonical identity | Pass | `linked-repository-url.ts`, `slug.ts`, link route/workflow, layout/hydrate; case and SSH native contracts |
| No-op export records resolved cutover tip | Pass | `persistMigrationExportNoOp`; completed-only `get/listMigrationExportSha` |
| Post-export bootstrap/cleanup, planner/caps | Open, declared | Generic follow-up helper still exists; typed export queues hydrate only. Counted as acknowledged planner work, not a new finding. |
| Remaining four kinds; pause/protection; semantic conflict; alternate writer/credential removal; legacy deletion | Open, declared | Status 132/139; excluded from finding count as instructed |

## Changed surfaces and callers inspected

- **Specs/standards:** recovery plan Gate 3 lines 642-659; tickets 02, 03, 09, 10, 12; ADR-033; root and backend `AGENTS.md`; code-review skill.
- **Schema/models:** `db/schema/workspaces.ts`; `models/workspace-write-jobs.ts`, `models/workspaces.ts`, `models/workspace-export.ts`, `models/github-installation.ts`. Traced completed/prepared/no-op SHA readers, linked repository queries, migration source load, create/retry serialization.
- **Domain:** commit subject, folder map, hydrate and hydrate-write-jobs, knowledge metadata/layout, link declarations/URL validation, slug identity, migration export and destination assignment, lifecycle, write command/broker/commit planning.
- **Workflow/admission:** enqueue selection and status failure path; all eight typed workflows; legacy generic workflow and its post-export caller; OpenWorkflow client and discovery registration.
- **Git/credentials:** clone-tree, pack capture/restore/read, write-tree stage/validate/commit, broker push/publication, GitHub installation credential model.
- **HTTP/product callers:** workspace create/retry, linked repository routes, file routes, workspace lifecycle auto-link/rename/relink.
- **Tests/evidence:** native write, maintenance, ops, link, migration-export, graph, Files HTTP, workspace HTTP, admission/discovery contracts; status/log manifests; CI contract and diagnostics allowlists.

## Searches/commands

`git rev-parse`; `git log BASE..TARGET --oneline`; `git diff --stat/--name-status/--name-only BASE...TARGET`; `git ls-tree -r --name-only TARGET`; pinned `git show ... | nl -ba`; pinned `git grep` for migration kinds, enqueue/persist/export SHA, URL normalization/validation, folder/YAML helpers, workflow registration, hydration and linked-repository callers.

## Finding count

Five correctness findings: four P1, one P2. Worst issue: an existing keyed knowledge file can lose customer body and metadata during migration export.
