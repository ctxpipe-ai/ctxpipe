# Gate 2 SPEC review — third-pass coverage supplement

## Identity and evidence status

- Base: `d87858354a783a9fd95c46785208c9b699a45e3b`
- Pushed reviewed candidate: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Review range: `git diff d87858354a783a9fd95c46785208c9b699a45e3b...bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Supplied commit list covers the series through `1b58d0bf`; terminal review additionally inspected `1b58d0bf..50db2359` and `50db2359..bb24210c`.
- Gate 0 scope authority: `docs/plans/workspace-recovery-gate-0/changed-files.txt` (801 paths), plus its `baseline.md`/status provenance.
- Reviewed prior oracle: `/private/tmp/gate2-spec-second.md` and `/private/tmp/gate2-spec-second-coverage.md`.
- Committed proof inspected with bounded JSON parsing: required contracts 130/130 in an 18-file inventory, zero pending/failures/skips/allowances; backend types exit 0 at the unchanged 146 allowance; proof policy exits 0; packaged Linux codesearch passes 173/173 Node and 42/42 Bun. Kubernetes memory/cleanup exits 0 at 5,230,137,344 bytes under 5,670 MiB with cold Zoekt/SCIP present and hot storage empty. Exact-`bb24210c` CI was 9/13 green at handoff; Tests, native Codesearch, UI image and Codesearch image remained running.
- The working tree is clean; local HEAD and the remote branch both resolve to `bb24210c`.

## Requirement matrix

| Requirement / locked behavior | Result at `bb24210c` | Evidence |
| --- | --- | --- |
| 1. `WorkspaceRevision` + `ProjectionState` at DB seam, temporary mappings | **Pass** | `domain/workspaces/revision.ts`; `models/workspaces.ts:196–267`; nullable migration; legacy active URL/SHA is explicitly discriminated rather than relabeled. DB JSON is parsed by `workspaceRevisionSchema`. |
| 2. One immutable revision resolver | **Pass** | `resolve-revision.ts` centralizes credential, native tip, null-SHA, branch and CAS capture and accepts only a complete expected `WorkspaceRevision`. Hydrate resolves before enqueue and validates it again at worker execution. |
| 3. One native Git tree/read path; no provider file loop | **Pass** | Hydrate uses `listMarkdownFilesAtGitSha`; batch `ls-tree`/`cat-file` and one history walk replace per-file GitHub calls. Temporary repositories select SHA-1/SHA-256 object format from the validated 40/64-hex identity; native SHA-256 acquisition passes. |
| 4. Pure parse + one CAS activation | **Pass** | `hydrate.ts` has pure path/parser transformations. `commitHydrateProjection` checks generation, URL, SHA, branch and connection while replacing units/membership in one PostgreSQL transaction (`models/workspaces.ts:1068–1192`). |
| 5. Embedding, graph and search freshness are independent derived results | **Pass** | `revision.ts` store results; `models/workspaces.ts:213–243,1579–1715`; Falkor marker/count/full-revision CAS in `graph-projection.ts:25–179`; previous published index retained while current index is pending/failed. |
| 6. Hydrate/search use the value; delete reconstruction/provider models | **Pass** | Enqueue/index/search/chat/Files/codesearch claims carry complete identity. Hydrate’s schema is strict and requires the canonical revision; the worker explicitly parses persisted pre-upgrade input. Existing provider columns are ADR-032 temporary mappings; generic ingestion/write clients are later-gate owners. |
| Same-SHA no-op / independent retry | **Pass** | Workflow compares published full revision and per-store results; graph/embedding/index retry from PostgreSQL without Git where possible. |
| Rewind and null-tip resolution | **Pass** | Native `ls-remote` resolver accepts 40/64 SHA and captures the current tip without ancestry ordering; normal enqueue resolves missing SHA. |
| Relink/generation/connection races | **Pass** | `nextRelinkFields`, duplicate-create retry, connection deletion and repository rebind reset/fence identity. `withOrgDbContext` is a transaction and nested `orgSql` reuses it. Stored primitive hydrate inputs fail worker validation rather than rebinding. |
| Malformed file and deletion behavior | **Pass** | Parser skips malformed knowledge/repository declarations; activation deletes/replaces the workspace row set atomically. |
| 100-file budget and per-file temporality | **Pass** | One native tree/batch/history path; introducing timestamp map is applied by unit path. Native SHA-1 and SHA-256 repository acquisition both pass. |
| Embedding/index/graph failure | **Pass** | PostgreSQL stays active; each failure is revision-fenced and retryable; prior search index remains published; incomplete/missing Falkor is explicit unavailable, never reconstructed from PG. |
| No partially exposed active revision | **Pass** | Unit/membership/metadata snapshot is one SQL statement; activation is one transaction; graph completion marker precedes PG ready CAS. |
| Hot search/glob/get-file and chat tools | **Pass** | Snapshot admits only stored indexed checkout SHAs; signed codesearch scope binds repository+SHA; chat exposes standard explorer tools including glob/get-file and retains the captured membership. |

## Third-pass findings and correction verification

### Partial hydrate command

At `50db2359`, `workspace-hydrate.ts` accepted primitive generation/URL/SHA/default-branch fields and ignored the branch while reconstructing current identity. At `bb24210c`, the schema is strict and requires `revision`; the worker explicitly calls `workspaceHydrateInputSchema.parse(queuedInput)` before policy work. `resolveWorkspaceReadRevision.expected` is now only `WorkspaceRevision`, and all production callers either capture before enqueue or pass the stored canonical value. The native persisted-old-input test proves OpenWorkflow enqueue validation alone is insufficient and the worker rejects the old run while preserving the prior active projection. ADR-032 explicitly records failure/recapture policy. `legacy-hydrate-worker-validation-green` exits 0; the earlier misleadingly named `legacy-hydrate-queue-green` exits 1 and is correctly labeled superseded diagnostic evidence in status.

### SHA-256 native acquisition

At `50db2359`, `clone-tree.ts` accepted 64-hex SHA but initialized a default SHA-1 object database. At `bb24210c`, `withFetchedGitSha` initializes SHA-256 for a validated 64-character identity and SHA-1 for 40 characters. The native fixture creates a real SHA-256 repository and reads its Markdown at the immutable commit; focused green evidence exits 0 across eight native Git cases. The shared checkout prefix extraction preserves the same wire key, validates workspace IDs once, and removes the last duplicated SQL key construction without changing authorization.

## Previous-review disposition

| Second-review finding | Third-pass result |
| --- | --- |
| Connection mutations bypass generation/link invalidation | **Closed.** Duplicate create, `updateWorkspace`, `deleteGithubConnectionById`, and shared-repository rebind use relink fields/invalidation inside ambient org transactions. |
| Last published search discarded | **Closed.** `hydratePhases.publishedIndex` retains a complete previous revision; index failures do not clear it; snapshots authorize its immutable checkout. |
| Null SHA not resolved | **Closed.** `resolveWorkspaceReadRevision` refreshes when desired SHA is null and the sole production hydrate enqueue calls it before queueing. |
| Missing `valid_from` / SHA-256 placeholders | **Closed.** Native history supplies a path timestamp and hydrate applies it per unit; 64-hex placeholders are recognized, and native SHA-256 repository acquisition passes. |
| Graph freshness/Falkor absent | **Closed.** Revision hash, marker counts, raw signals, failure result, retry and immutable read are implemented with no PostgreSQL fallback. |
| Files remote fetch; chat lacks glob/get-file | **Closed.** Both use captured immutable codesearch checkout identities; chat exposes the standard explorer family. |
| Dead reconstruction helpers | **Closed.** Prior explorer/hydrate helpers are deleted. The hydrate workflow now rejects primitive persisted input and has no reconstruction fallback. |

## Repository coverage map

| Area | Paths/interfaces traced and conclusion |
| --- | --- |
| Authority and scope | Root/backend/UI/codesearch/docs `AGENTS.md`; recovery Gate 2 lines 621–640 and later-gate ownership; Gate 0 baseline/801-path manifest; Gate 2 status; ADR-008/010/018/022/023/025/031/032; locked issues 02/03/08/09/10/11/12/18 and map. Graph GC confirmed Gate 6 with conversation lifetime. |
| Schema and migration | `db/schema/workspaces.ts`, repository checkout/repository/connection schemas, revision migration SQL/snapshot, model record mappings. Historical identities remain legacy; no invented generation/branch/connection. |
| Revision writers | Every production `update/insert/delete(workspaces)` and linked-repository mutation; create/update/delete, connection detach/rebind, tip capture/failure, hydrate CAS, embedding/index/graph publication. Nested ambient org SQL transaction semantics verified in `db/client.ts` and `db/org-sql.ts`. |
| Resolve/hydrate/native Git | Hydrate enqueue and workflow, resolver/credentials, parser/layout/phase logic, Git tree/batch/history reader, all production call sites. The two review findings are corrected in `bb24210c`; provider contents calls are not hydrate readers. |
| Search/index/codesearch | Workspace/repository index schemas and children, checkout rows/keys, shared source packaging, JWT admission, index publish, Zoekt version filters, SCIP/structural/glob/file routes. Immutable repository+SHA scope and legacy read-only scope pass. |
| Snapshot/chat/graph | One-statement projection/unit/vector/membership query; chat explorer wrappers/hybrid retrieval; Falkor projection/client/read; graph HTTP and tools. Captured immutable values are retained. `tanstack-workspace-chat.ts` catch-to-empty remains Gate 4-owned error convergence. |
| Connector/generic/write | GitHub connection deletion, repository rebinding, webhooks/tip check, connector targets, generic repository ingestion and workspace write jobs. No workspace truth is taken from generic `lastIngestedHash`. Write-command convergence remains Gate 3. |
| UI and APIs | Workspace DTO/schema, list/detail/retry/Files/graph/linked routes; UI workspace queries/list and connector/repository consumers. Transitional presentation/polling remains Gates 5–6; no extra Gate 2 correctness dependency found. |
| Proof/deploy | Required inventories/results, all-project types, lint/policy/CI-command logs, packaged source image config and Node/Bun reports, Kubernetes memory/cleanup, and SHA-256 red/green. Exact-SHA CI acceptance remains separate from code findings. |

## Bounded commands/searches

All commands ran from `/private/tmp/ctxpipe-recovery-01a07aba`. No heavy suite was started and logs/lockfiles were not dumped.

```text
git rev-parse BASE CANDIDATE; git show-ref; git status --short
git diff --stat BASE...CANDIDATE; git diff --name-status BASE...CANDIDATE
git log --oneline --reverse BASE..CANDIDATE; git log 1b58d0bf..50db2359; git log 50db2359..bb24210c
git show CANDIDATE:<path> | nl -ba | sed -n <bounded-range>
git diff BASE...CANDIDATE -- <targeted paths>
git diff --check BASE...CANDIDATE (diagnostic evidence files contain pre-existing captured whitespace; no source finding)
git grep -n 'update(workspaces)|insert(workspaces)|delete(workspaces)' CANDIDATE -- production TypeScript
git grep -n 'update(workspaceLinkedRepositories)|insert(...)|delete(...)' CANDIDATE -- production TypeScript
git grep -n 'desiredGeneration|desiredSha|desiredDefaultBranch|activeRevision|indexedSha|hydrateStatus' CANDIDATE -- bounded production paths
git grep -n 'workspace-hydrate|enqueueWorkspaceHydrate|workspaceHydrate.spec' CANDIDATE
git grep -n 'repos.getContent|contents/' CANDIDATE -- backend/UI production paths
git grep -n 'activeProjectionSha|activeProjectionUrl|lastIngestedHash|legacyWorkspace' CANDIDATE -- production paths
git grep -n 'git.*init|["init"' CANDIDATE -- backend/codesearch production paths
git ls-tree -r --name-only CANDIDATE <subtrees> | rg <targeted vocabulary>
jq 'keys' <bounded evidence.json>
jq '{name,exit_code,duration_seconds,log}' <command evidence.json>
jq '{success,numPassedTests,numTotalTests,numFailedTests,numPendingTests,...}' <Vitest evidence.json>
find docs/plans/workspace-recovery-gate-2/logs -maxdepth 1 -type f -name '*.json' ... | head/tail
```

## Later-gate ownership preserved

- Gate 3: write-job transaction/runner/provider write convergence.
- Gate 4: sandbox/chat lifecycle, HTTP/WebSocket convergence, warm-turn provider removal, catch-to-empty and process cleanup.
- Gate 5: UI command/polling/save-publish behavior and browser proof.
- Gate 6: remove transitional columns/adapters/legacy checkout after upgrade proof; golden/deletion ledger; retired immutable Falkor revisions only after captured conversation lifetime is proven.
