# Gate 2 standards review — third-pass coverage

## Review identity and limits

- Fixed base: `d87858354a783a9fd95c46785208c9b699a45e3b`
- Exact reviewed candidate: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Diff: `git diff d87858354a783a9fd95c46785208c9b699a45e3b...bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Both commits resolved; merge-base comparison and diff were non-empty. `/private/tmp/gate2-third-commit-list.txt` contained nine original candidate commits; the correction commits were additionally enumerated with `git log`.
- Review was read-only. Heavy suites were not repeated while packaging/memory/CI proof ran; recorded JSON, bounded log tails, and targeted correction evidence were inspected.
- Gate 3–6 compatibility was excluded unless required for Gate 2 correctness. Retired immutable graph GC remains Gate 6 because it must honor captured conversation lifetime.

## Requirement and rule matrix

| Requirement / standard | Result | Evidence and judgment |
|---|---:|---|
| Backend/runtime seams (ADR-002; backend AGENTS) | Pass | Hono/Bun/Zod/module boundaries remain intact; no new provider-specific domain identity or credential persistence. |
| RLS and tenant isolation (ADR-028) | Pass | Tenant SQL remains in short org-scoped transactions; remote Git, codesearch, embedding, and graph I/O assert/run outside org DB context. |
| Canonical revision model (ADR-032:11-21) | Pass | `revision.ts` defines complete `WorkspaceRevision`, `LinkedRevision`, store freshness, and discriminated `ProjectionState`; model boundary reconstructs legacy explicitly. |
| Durable hydrate identity (ADR-032 durable-queue section) | Pass | `workspace-hydrate.ts:42-52,84-114` accepts and worker-validates only complete revision input. Enqueue resolves/captures before persistence; old primitive input fails rather than rebinding. |
| Full-identity retries and CAS | Pass | `tip-resolve.ts:10-31`; `workspace-tip-check.ts:113-128,154-179`; activation, failure, index, graph, and linked publication compare captured identity. Same-SHA branch/relink cases are covered. |
| Native provider-neutral Git (ADR-032:11,27) | Pass | Hydration uses native immutable tree reads; remaining provider `getContent` callers are write/configuration surfaces. `clone-tree.ts:103-145` supports validated 40/64-character hashes and credential-free origins. |
| Shared checkout wire format (ADR-032:17) | Pass | `shared/workspace-checkout.ts:1-21` owns legacy key, immutable key, and SQL prefix; backend/codesearch re-export/use it. Model SQL binds helper results; no production parallel `ws:` formatter remains. Both images copy shared source; `shared/tsconfig.json` isolates its dependency-free typecheck. |
| Immutable codesearch authorization (ADR-032:17) | Pass | JWT claims bind repository IDs to SHAs; immutable/legacy paths are discriminated; admission rejects contradictory target/key; search/SCIP/structural reads use captured membership. |
| One PostgreSQL snapshot (ADR-032:15) | Pass | `getWorkspaceProjectionSnapshot` gathers metadata, units, linked membership, and allowed immutable checkouts in one statement. |
| Derived graph publication (ADR-032:30-36; ADR-010) | Pass | Revision-keyed nodes/claims plus completion marker precede full-revision CAS. Reads require a complete ready marker and return explicit unavailable; no PostgreSQL reconstruction. Falkor client bounds/caches connect and closes at shutdown. |
| Connection lifecycle | Pass | URL/connection rebind advances generation and fences owner/linked work. Credentials remain transient; webhook tips enter the common durable resolver. |
| Public-seam TDD (`tdd/SKILL.md`; `tests.md`; `mocking.md`) | Pass | Required contracts are sliced by behavior, use native collaborators at agreed service seams, and contain no skips/retries/`vi.mock`. Obsolete characterization and mocked Graph-pane proof were removed. |
| Required recovery proof (ADR-031) | Pass | Manifest records 130 cases across 18 required files, zero skips/allowances; all seven complete type projects pass with recorded baseline counts. |
| Logging / operator surface (root/backend/codesearch AGENTS) | Pass | No new `console.*`, feature-toggle env var, owner-role bypass, or silent graph fallback in changed production source. |
| UI boundary (UI AGENTS; ADR-030) | Pass | UI changes are compatibility typing/removal only; substantial projection/polling migration is Gate 5. |
| Packaging / native acceptance | Pass | Shared-source image proof: 173 Node + 42 Bun, zero skips/allowances. Native SHA-256 Git proof passes. Kubernetes cold Zoekt+SCIP/hot-empty/cleanup passes at peak 5,230,137,344 bytes. |
| Exact-candidate CI | Pending acceptance | Exact-SHA dispatch is underway. This is separated from the zero-blocker code-standards judgment. |

## Prior finding closure

| Second-pass finding | Closure evidence |
|---|---|
| SHA-only cron retry | `shouldEnqueueCronHydrate` consumes `ProjectionState`; readiness is full store state. Same-SHA default-branch change and connection/relink cases are native contracts. |
| Dead partial-identity helpers | `git-explorer.ts`, `hydrate-phases.ts`, and obsolete partial helpers/tests in `hydrate.ts` were deleted; exact-symbol searches found no alternate producer. |
| Oversized contracts | Chat, Files, and code-search proof is separated into named public behaviors; implementation call-count and fixture-close assertions are gone. |
| Duplicated checkout formatter | Backend and codesearch use `shared/workspace-checkout.ts`; model SQL also binds the shared base/prefix. |
| Files middle men | Delegation-only wrappers were removed; routes call the checkout read boundary directly. |

## Full smell baseline

| Heuristic | Result |
|---|---|
| Mysterious Name | Not found; changed identity/publication names expose their domain role. |
| Duplicated Code | Addressed: checkout protocol and codesearch response diagnostics have one implementation each. |
| Feature Envy | Not found; model/domain/service responsibilities remain at their owning data boundary. |
| Data Clumps | Addressed by `WorkspaceRevision`, `LinkedRevision`, `ProjectionState`, and store freshness types. |
| Primitive Obsession | Repo rule controls: transitional primitive columns are explicit migration mappings; hashes are schema-validated immutable values. |
| Repeated Switches | Not found; discriminated projection handling is localized and exhaustive. |
| Shotgun Surgery | Not found; cross-service changes follow one shared protocol and explicit adapter boundaries. |
| Divergent Change | Not found; touched modules retain one lifecycle/service responsibility. |
| Speculative Generality | Addressed: dead partial helpers, optional primitive hydrate input, and unused wrappers were deleted. |
| Message Chains | Not found. |
| Middle Man | Addressed: Files delegation-only wrappers were removed. |
| Refused Bequest | Not applicable; no changed inheritance hierarchy. |

These are judgment heuristics only. ADR-032’s explicit migration/later-gate ownership overrides baseline concerns about transitional compatibility fields.

## Interface and repository-wide coverage map

| Surface | Traced owners and consumers |
|---|---|
| Identity/model | Revision schemas/equality, workspace schema/migration, capture/activation/failure, projection snapshot, legacy reconstruction. |
| Producers/lifecycle | Workspace create/relink, connector rebinding/deletion, tip cron, webhook dispatch, hydrate/index/graph enqueue and publish. |
| Readers | Chat captured snapshot/tools, Files tree/blob, code search, SCIP, structural search, Graph HTTP and chat graph. |
| Codesearch | JWT parsing, checkout selection, index admission, repository/checkouts DB rows, Zoekt/SCIP paths, all read routes. |
| Native Git | Tip resolution, token scoping, fetch/tree/blob/history parsing, SHA-1/SHA-256 init, hostile paths, batch framing. |
| Graph | Projection key, completion marker, tenant graph selection, writer CAS, route auth/unavailable behavior, Falkor lifecycle and cleanup. |
| Outside expected directories | Connector routes/models, UI DTO callers, CI workflow/prerequisites/manifests, Dockerfiles, shared source, migration/lock patch, ADR/status/evidence. |
| Old/parallel paths | Legacy columns/checkouts, provider `getContent`, raw checkout literals, partial identity helpers, mocked Graph reconstruction, duplicate response parsing. |

## Commands and bounded searches

- Identity: `git rev-parse`, `git merge-base`, `git log --oneline`, `git diff --stat/name-only/shortstat`, and scoped `git diff`/`git show` against the fixed base and exact candidates.
- Repo-wide `rg`/`git grep` for `WorkspaceRevision`, `LinkedRevision`, `ProjectionState`, active/desired/indexed SHA/URL fields, `workspaceCheckoutKey`, `ws:`, `checkoutKey`, graph markers, `getContent`, workflow producers/callers, and legacy hydrate shapes.
- Contract audit searches for test names/expectation counts, `vi.mock`, skip/todo/fails/retry modifiers, `console.*`, environment toggles, and logging calls.
- Read all applicable root/backend/codesearch/UI `AGENTS.md`; code-review and TDD `SKILL.md`, `tests.md`, `mocking.md`; ADR-002/008/010/014/028/030/031/032; recovery spec; Gate 0 scope manifest; prior standards review and coverage.
- Inspected bounded JSON summaries/log tails for required contracts, seven type projects, Linux image packaging, SHA-256 Git, and Kubernetes memory/cleanup. Mechanically enforced formatting/diagnostic inventory was not reranked as a manual standards finding.
