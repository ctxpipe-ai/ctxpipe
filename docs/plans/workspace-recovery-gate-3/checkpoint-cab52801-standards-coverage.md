# Gate 3 twelve-kind checkpoint — Standards coverage ledger

## Review identity and method

- Base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Target: `cab528013bb3e49ddfc05d419984f03494d6579d`
- Merge base: fixed base above; target was present locally and reviewed through `git diff`, `git log`, `git show`, `git grep`, and `git ls-tree` against the pinned object database. No current-worktree source was used.
- Changed surface enumerated: 534 paths — 51 backend implementation TypeScript files, 22 backend test TypeScript files, 448 Gate 3 evidence/plan files, and 13 ADR/index/package/lockfile/prior-gate/diagnostic/contract files.
- Standards read at the target: root `AGENTS.md`; `apps/backend/AGENTS.md`; `.agents/skills/code-review/SKILL.md`; `.agents/skills/tdd/SKILL.md` and `mocking.md`; ADR-027, ADR-028, ADR-033; accepted recovery plan and current Gate 3 status. Tooling-enforced style was excluded.

## Changed implementation surfaces

- Durable schema/models: workspace write-job payload fields and status transitions; revision binding; completed knowledge-path persistence/lookup; export source projection; workspace, GitHub, Linear, Notion, Slack, and Confluence binding readers.
- Domain transforms: command and admission schemas; commit subject; migration export/projection; connector mirror; bootstrap/layout; file edits; claims and valid-from changes; import-key cleanup; link/unlink; ops folder map; rename rewrite; extraction; semantic merge; graph/hydration behavior.
- Native Git services: pack/shallow reconstruction, file staging and deletion, tree/commit creation, repository reads, merge-tree candidate construction, native three-way rebase, and object repacking.
- Workflows: discovery/enqueue plus all twelve typed workflows (`bootstrap`, `file_edit`, `import_key_cleanup`, `claims_upgrade`, `valid_from_persist`, `ops_folder_map`, `link_unlink`, `migration_export`, `rename_rewrite`, `extract_ingest`, `connector_mirror`, `semantic_merge`) and the remaining compatibility runner touched by shared interfaces.
- Entry points: workspace routes and linked routes, OpenWorkflow client, ingestion schema/model provider, hydration, test fixtures, package/vitest configuration, CI contracts and diagnostics.

## Interface and caller tracing

- `loadKnowledgeProjectionSource` / `planKnowledgeProjection`: traced through migration export, extract ingest, the compatibility write workflow, file planner types, and migration-export/native export/extraction tests.
- `getCompletedKnowledgePaths` / `persistWriteJobKnowledgePaths`: traced through extraction, migration export persistence/no-op behavior, write-job payload schema, and repeated/collision/imported-path characterization tests.
- Connector binding results: traced every changed reader and consumers — Linear config/content/entity/routes; Notion entity/routes; Slack routes; Confluence routes/webhooks/sync services. The broker now receives repository URL and connection ID from one joined reader result. The added result fields are compatible with all destructuring callers.
- `connectorMirrorContentSchema` and mirror payload: traced enqueue/admission, running and paused workflow branches, broker recheck, completion/no-op results, and paused/complete binding contracts.
- Semantic merge: traced job-kind/payload schema, enqueue admission, workflow discovery, `previousSha` validation, acquisition, candidate staging, `git merge-tree`, changed-path validation, subject/commit creation, push/binding checks, publication/hydration, replay, and no-op. Native contract covers a clean concurrent edit plus deletion and sole-current-tip parent.
- Shared Git pack/file helpers: traced all twelve workflows and native contract fixtures for binary bytes, modes, missing paths, shallow boundaries, replay, and no-op behavior.

## Prior finding regression checks

- Resolved: provider binding no longer combines URL and connection ID from separate SQL snapshots.
- Resolved: projection/extraction helper and step names state their responsibility.
- Still resolved: YAML alias/comment/BOM/CRLF/root-node preservation, encoded folder paths, canonical link identities, export metadata, collision allocation, source credentials, null import keys, nested aliases, folder headings, binary/mode preservation, and terminal publication ordering.

## Findings covered

1. ADR-033 path retention: inspected planner input selection, result construction, latest completed-map query, persistence on commit/no-op, and repeated/collision tests. Found loss across a projection in which an earlier object is absent.
2. Transaction consistency: inspected `withAmbientOrgDb`/`withOrgDbContext`, source loader's multi-table transaction, completed-path query, migration-export marker query, and extraction step ordering. Found the combined durable source assembled from three transactions.
3. Fowler baseline: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, and Refused Bequest considered across changed production code. No new heuristic finding was reported.

## Evidence and scope boundary

- Read supplied status/evidence for 35 affected checks and full backend types with 141 pre-existing allowances; no heavyweight suite was rerun.
- Explicitly excluded from surprise-omission findings: overlapping/model conflicts, automatic conflict handoff, explicit provider resource steps, post-hydrate planning/caps, full pause/resume, provider caller migration, alternate writer/credential removal, and generic runner deletion.
- This is an intermediate checkpoint review, not Gate 3 terminal acceptance.
