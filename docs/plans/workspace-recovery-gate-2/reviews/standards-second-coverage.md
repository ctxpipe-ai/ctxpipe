# Gate 2 standards review — coverage supplement

## Review identity and limits

- Fixed base: `d87858354a783a9fd95c46785208c9b699a45e3b`
- Reviewed candidate: `6d0f0709acf9bab60caa09813e2086251aa679aa`
- Diff: `git diff d87858354a783a9fd95c46785208c9b699a45e3b...6d0f0709acf9bab60caa09813e2086251aa679aa`
- The local branch and verified remote matched the candidate when review began. Concurrent recovery edits subsequently dirtied the worktree; conclusions use committed candidate content through `git show` and `git grep <candidate>`.
- I did not run heavy suites during the active Kubernetes memory run. Test conclusions use bounded inspection of the recorded structured results and logs.

## Requirement and standard matrix

| Requirement / standard | Result | Evidence and judgment |
|---|---:|---|
| Backend stack/runtime and shared domain seams (ADR-002) | Pass | Changed backend code remains Hono/Bun-compatible, keeps Zod schemas collocated, and routes/tools reuse domain services. |
| Parallel-worktree isolation (ADR-014; root/backend AGENTS) | Pass | The review used the assigned checkout and did not alter worktree setup, shared infrastructure, ports, or database naming. Changed CI does not replace the established isolation model. |
| App-role RLS and fail-closed tenancy (ADR-028) | Pass | Tenant reads/writes remain inside short `withOrgDbContext` transactions; changed code adds no owner-role bypass, session GUC, boot probe, or `SECURITY DEFINER` path. |
| Stock TanStack chat path (ADR-030; UI AGENTS) | Pass | The Gate 2 chat projection changes preserve the official conversation/runtime path. UI edits are compatibility typing only, with no substantial component, hook, or fetch-flow change. |
| Canonical `WorkspaceRevision`, `LinkedRevision`, and `ProjectionState` (ADR-032:7-21) | Pass | `revision.ts`, workspace models/schema/migration, snapshot and activation paths use complete revision records. |
| Resolve identity once at DB/product boundary; retry by full identity (ADR-032:11-19) | **Fail** | Resolver captures full identity, but `workspace-tip-check.ts:163-170` → `tip-resolve.ts:8-18` admits cron retry by SHA alone. Same-SHA relink/branch-change replacement can be stranded. |
| No partial identity reconstruction; remove obsolete path (ADR-032:7-19; Gate 2 deletion rule) | **Fail** | Test-only backend helpers in `git-explorer.ts:19-72`, `hydrate-phases.ts:32-64`, and `hydrate.ts:101-139,157-187` reconstruct targets/readiness from legacy URL/SHA/index fields. |
| Native Git checkout reads and parsing | Pass | Hydration uses clone/fetch/worktree and native path/blob readers; no provider `getContent` call remains in the reviewed hydration path. Native contracts cover hostile filenames and batch framing. |
| Derived writes fenced by captured revision; publish atomically | Pass | Index/blob/graph writers carry captured revision and use activation checks/transactions. Independent spec review owns the subsequently identified stale-index retention fix. |
| One captured chat snapshot | Pass | Chat runtime/tools share the captured projection and graph snapshot. Gate 4 owns lifecycle cleanup and compatibility removal. |
| Explicit connection identity; credentials transient (backend AGENTS:13; ADR-032) | Pass | Resolver carries `connectionId`; immutable checkout authorization has an explicit legacy mode. No credential material is persisted in revision identity. |
| Short DB transactions; no network I/O under org DB context (ADR-028) | Pass | Resolution performs remote tip work outside commit transactions; model updates are local, bounded transactions. |
| Truthful contracts and explicit allowances (ADR-031) | Pass | Required suites and typecheck manifests record explicit projects/allowances. |
| TDD public-seam slicing (`tdd/SKILL.md:14,20-37`; `tests.md:19-23,38-45`) | **Fail** | Three oversized contract files mix many public behaviors; codesearch test additionally asserts request count and fixture cleanup state. |
| Backend/codesearch logging conventions | Pass | Exact changed-source searches found no new `console.*`; production logging remains structured. |
| Codesearch service and ingest rules (`apps/codesearch/AGENTS.md`) | Pass | The service retains Bun/Hono orchestration, fixed checkout helpers, fail-closed clone/SCIP behavior, and recorded manual Kubernetes memory evidence. Its clean rerun remains pending as stated below. |
| Documentation scope/style (`apps/docs/AGENTS.md`) | Pass | No product-documentation implementation was added under `apps/docs`; changed planning/evidence documents remain within the recovery plan's required record. |
| Root code-style/operator surface (`AGENTS.md`) | Pass | No unnecessary global, feature-toggle environment variable, package release, or local-development contract was introduced. |
| TDD mock policy (`mocking.md`) | Pass | Contract proof runs owned collaborators in-process; substitutions are at external/process boundaries. No new `vi.mock`, skipped, or retry-decorated contract proof was found. |
| Migration fresh + upgrade proof | Pass | `migrate-revision-fresh-and-upgrade` recorded exit 0. |
| Linux/native/image/memory evidence | Pending | Native 77/77, Linux codesearch 215/215 across 34 files, seven project typechecks, and final image build are recorded green. Earlier memory proof measured peak `5,103,169,536 < 5,670 MiB` but wrapper cleanup failed. Clean rerun and exact-SHA CI were still running; no terminal claim is warranted. |

## Per-file documented-standard findings

### Complete-identity retry

- `apps/backend/src/openworkflow/workflows/workspace-tip-check.ts:163-170`: uses SHA-only `shouldEnqueueCronHydrate` when no newly updated tip is returned.
- `apps/backend/src/domain/workspaces/tip-resolve.ts:8-18`: `desiredSha !== activeProjectionSha` ignores generation, connection, branch, and remote identity. ADR-032:11-19 requires the complete revision identity. Its test covers SHA/export gating only and omits same-SHA identity replacement retry.

### Obsolete partial-identity helpers

- `apps/backend/src/domain/workspaces/git-explorer.ts:19-72`: `workspaceExplorerRemote`, `workspaceExplorerSha`, and `workspaceGitExplorerTarget` fall back through `activeProjection*` and `desiredSha`. Exact-candidate tracing finds no production consumer; `git-explorer.test.ts:12-125` is their only consumer.
- `apps/backend/src/domain/workspaces/hydrate-phases.ts:32-64`: `hydratePostgresIsComplete` and `pendingHydratePhases` infer completeness from URL/SHA and `indexedSha`; only `hydrate-phases.test.ts` consumes them.
- `apps/backend/src/domain/workspaces/hydrate.ts:101-139,157-187`: `hydrateReadsStoredDesiredSha`, `hydrateIsNoop`, `shouldReplaceKnowledgeProjection`, `workspaceProjectionReady`, `workspaceHydrateView`, and `workspaceHydrateInFlight` are test-only partial-state reconstructions; only `hydrate.test.ts` consumes them.

These violate ADR-032:7-19, especially its rule that legacy URL/SHA columns are temporary mappings and cannot prove revision identity. Keeping test-only implementations and characterization tests also fails Gate 2’s required obsolete-path deletion. `docs/plans/workspace-recovery-gate-2/status.md` therefore overstates deletion at candidate SHA.

### Test organization

- `apps/backend/src/domain/workspaces/chat-projection.contract.test.ts:29-277`: one test, 26 expectations, and at least eight independently describable public behaviors.
- `apps/backend/src/routes/v1/workspace-files.contract.test.ts:156-193`: tree, text, binary, missing, and traversal behaviors in one test; `:255-312`: traversal, read-only, legacy, and absent behaviors in one test.
- `apps/backend/src/retrieval/services/code-search-projection.contract.test.ts:27-268`: selected repositories, all repositories, and stale-version behavior in one test; `:214` asserts `codesearchRequests === 2`; `:262-268` checks internal fixture close state.

The TDD skill requires one behavior/one seam per slice and identifies call counts, ordering, and implementation details as red flags. These are hand-authored standards breaches rather than tool-enforced style findings.

## Judgment-smell inspection

| Smell | Result | Hunk |
|---|---:|---|
| Duplicated Code | Present | `apps/backend/src/domain/workspaces/derived-stores.ts:22-32` and `apps/codesearch/src/domain/repositories/paths.ts:8-18` contain the same `workspaceCheckoutKey` regex replacement and `${workspaceId}-${suffix}` formatting. A shared protocol helper would prevent backend/codesearch drift. |
| Middle Man | Present | `apps/backend/src/routes/v1/workspace-files-routes.ts:285-294`: `readExplorerTree` only returns `listWorkspaceCheckoutPaths(input)` and `readExplorerBlob` only returns `readWorkspaceCheckoutFile(input)`. |
| Mysterious Name | Not added | No changed identifier was sufficiently unclear to justify a standards finding. |
| Feature Envy | Not found | Changed methods do not primarily manipulate another module's internal data. |
| Data Clumps / Primitive Obsession | Addressed | The revision fields are bundled into `WorkspaceRevision`; remaining transitional DTO fields are Gate 5/6 compatibility surfaces. |
| Repeated Switches / Refused Bequest | Not found | No repeated discriminator cascade or inheritance misuse in changed hunks. |
| Shotgun Surgery / Divergent Change | Not found | The cross-service identity change is intentionally gathered around the shared revision protocol and service boundaries. |
| Speculative Generality | Superseded by rule | Dead partial helpers are reported as the stronger ADR/Gate 2 deletion violation. |
| Message Chains | Not found | No newly exposed navigation chain requires hiding. |

## Repo-wide interface and parallel-implementation coverage

| Surface traced | Files / symbols followed |
|---|---|
| Database and models | Revision migration, workspace schema/model fields, desired/active revisions, activation transaction, projection snapshot query. |
| Lifecycle and producers | create/update/relink, tip resolution, cron tip check, webhook dispatch, hydrate workflow, indexing enqueue/admission. |
| Backend readers | workspace files tree/blob, codesearch projection, chat runtime/tools, graph lookups, derived stores. |
| Codesearch service | repository auth/schema, index route, immutable checkout claim, checkout path helper, clone/fetch/worktree and parsing. |
| Auth and compatibility | JWT revision claims, explicit legacy authorization, connector route type-chain changes. |
| UI/docs compatibility | Projection status DTOs/helpers and docs compatibility surfaces inspected; functional UI migration belongs to Gate 5. |
| CI and proof | Required-contract manifest, Linux codesearch runner, seven-project type manifest, migration proof, image build, Kubernetes memory wrapper/artifacts. |
| Outside expected directories | Exact-candidate searches for revision/projection types and legacy URL/SHA/index fields covered backend, codesearch, UI, connectors, scripts, docs, migrations, and tests. |

## Commands and bounded searches

- `git status --short --branch`; `git rev-parse HEAD`; `git merge-base`; `git diff --stat`; `git diff --name-status`; `git diff --numstat`.
- `git diff <base>...<candidate> -- <bounded path>` and `git show <candidate>:<file>` for changed hunks and exact line context.
- `git grep -n <symbol> <candidate> -- <scoped paths>` for every added/changed identity, lifecycle, reader, authorization, and compatibility symbol.
- Searches included `WorkspaceRevision`, `LinkedRevision`, `ProjectionState`, desired/active revision fields, `activeProjection*`, `desiredSha`, `indexedSha`, legacy checkout keys, `sandboxSnapshotKey`, provider `getContent`, native Git batch commands, logging, mocks, skips, and retry modifiers.
- Parsed recorded JSON summaries and bounded log tails rather than printing complete logs or manifests.

## Obsolete owners and later-gate boundary

Current Gate 2 owners:

- Full-identity cron retry admission and same-SHA relink/branch-change proof.
- Delete the dead backend explorer/hydration reconstruction helpers and their obsolete characterization tests.
- Slice the three named contract files by public behavior and remove implementation-detail assertions.

Other independent Gate 2 review fixes already being handled by the parent include duplicate-create rebind, stale-index retention, resolve-if-null hydrate behavior, and remote fetches in Files hot reads.

Later-gate owners, excluded from current Gate 2 findings:

- Gate 3: write job lifecycle, commit/push, and its characterization replacement.
- Gate 4: chat lifecycle, sandbox snapshot-key retirement, catch behavior, and file publication semantics.
- Gate 5: UI projection status, polling, and workflow-engine migration.
- Gate 6: remove transitional `activeProjection*`/desired/indexed mappings, legacy workspace checkout compatibility, obsolete characterization tests, golden fixtures, and compatibility docs.
