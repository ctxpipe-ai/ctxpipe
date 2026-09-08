# Gate 2 — revision and projection ownership

Status: IN PROGRESS.
Fixed starting checkpoint: `d87858354a783a9fd95c46785208c9b699a45e3b`, independently approved and verified remotely after all 13 Gate 1 CI jobs passed.

Gate 1 terminal evidence is recorded alongside this starting checkpoint. Gate 2 implementation follows the requirements in `../workspace-chat-recovery.md`: immutable revision policy, one native Git acquisition path, pure parsing, atomic generation/SHA activation, and independent derived-store freshness. Required contracts cover no-op, rewind, relink races, malformed files, deletion, 100-file budget, derived failures and atomic visibility.

## First contract: native tree command budget

The existing 100-file hydration workflow launched 104 top-level Git commands. The new contract observes Git's own Trace2 events while executing the real OpenWorkflow/PostgreSQL path and sets an eight-command tree budget. The initial run failed only the 100-file case; zero/one-file cases passed.

Native Markdown acquisition now uses nul-delimited tree metadata and one `git cat-file --batch` process. The same three hydration cases and three existing Git contracts pass. In the observed local runs, the 100-file workflow case took 10.9 seconds before and 4.5 seconds after; these are individual measurements, not a completed Gate 2 performance claim.

Remaining Gate 2 work includes one revision/projection model, native tip and private-repository read policy, removal of provider file loops, revision-scoped activation/failure/derived-store operations, search integration, complete race/failure/deletion contracts, and the final independent review.

## Native Git and queued-generation contracts

A real queued generation-1 hydrate followed by a generation-2 update previously activated the stale job. The worker now discards an explicitly stale generation/URL/SHA before repository acquisition. `stale-generation-red` reproduces the activation; `stale-generation-green` passes all seven then-existing Git/hydration cases. Capturing that immutable identity at every enqueue and fencing later failure/derived writes remain part of the revision-model work.

The product tip resolver now handles native remotes and their actual default branch. `native-tip-red` returned null for a real non-GitHub repository; `native-tip-green` passes default `trunk`, explicit branch, and rewind checks.

Private Git acquisition now supplies the repository-scoped credential via a transient child-process HTTP header and leaves `origin` credential-free. `private-origin-red` observes the previous credential-bearing origin using the real Git config during a smart HTTP fetch. `private-origin-green` passes all nine then-existing native Git/hydration checks. The first private fixture used dumb HTTP, which does not support shallow Git; the smart HTTP fixture runs the real `git http-backend`. Trace2 already redacts URL passwords, so a trace-only check was insufficient and was strengthened with the origin observation. The fixture credentials are synthetic.

The batch implementation resolved five backend diagnostics. `native-tree-typecheck-green` passes with the finite allowance reduced from 177 to 172; no new diagnostic identity was accepted. `native-read-policy` passes the proof policy. Later edits still require their own final checks and gate review.

GitHub-connected hydration now uses the same native Git reader, with `getRepoReadCloneToken` requesting only one repository and `contents:read`/`metadata:read`. The obsolete provider-selection helper and its implementation-only test were deleted. The product contract uses a real PostgreSQL connection row, real Octokit signing/auth request, and Git's own URL rewrite to a real fixture repository; only external token/embedding HTTP responses are substituted. The private HTTP transport is separately exercised with real `git http-backend`.

`github-provider-loop-red` proves the old GitHub path reported successful hydration of zero units when the provider tree returned 404. `github-native-hydration-final` passes all 25 Git/hydration/parser checks, including 100 GitHub-connected files within the eight-command budget and the exact scoped token request. Earlier GitHub fixture attempts exposed missing required fixture booleans, an empty unscoped-token body, and a mistaken expected request key; these were fixture corrections, not product evidence. The current assertion uses Octokit's `repositories` wire field.

The initial full contract lane passed 26 of 27 checks; its only failure was the existing native Git multi-operation test's five-second default timeout under concurrent native/TypeScript load. The Git suite now has an explicit 30-second timeout and the full required lane is rerun without exclusions or allowed failures.

`native-path-contract-lane-final` passes all 27 required cases in seven files, with zero skips and zero allowed failures. Raw structured results and the discovered inventory are saved as `native-path-contract-results.json` and `native-path-contract-inventory.json`. This is a partial Gate 2 checkpoint, not gate completion; `native-path-typecheck` also passes the complete backend with 172 existing diagnostics and no new identities. The revision model, remaining contracts, and independent final reviews are outstanding.

## Revision identity slice

Partial native-read checkpoint `1088c8b46aa32f9c6dec117b2833f17cd2f2bf3a` was pushed and independently verified with `git ls-remote`. Gate 2's fixed review starting point remains `d87858354a783a9fd95c46785208c9b699a45e3b`.

The next contract (`projection-identity-red`) required a public model read that preserves published generation/remote/connection/branch/SHA identity. Drizzle generated `20260908012604_workspace-revision-identity`, adding nullable desired branch metadata and the complete active revision. `migrate-revision-identity` applied it to the disposable database and provisioned the app-role grants. No historical identity is fabricated; old URL/SHA projections have an explicit legacy representation.

`projection-identity-green` passes 31 cases in five files. It includes initial activation, a same-SHA no-op, retaining generation 1 as the previous published projection after generation 2 is requested, and generation-2 activation even at the same URL/SHA. The activation model now accepts one revision value and performs one conditional update within the transaction that replaces units and linked membership. The complete canonical read/failure/derived-store and caller migration is still in progress.


## Atomic projection and independent derived results

The model now exposes one-statement projection/unit snapshots. `projection-history-contract` proves replacement, deletion, malformed-file diagnostics, rewind, and rollback after a real duplicate-key failure; the failed transaction leaves the prior metadata and units visible together.

`stale-projection-failure-red` and `stale-embeddings-red` reproduced writes from generation 1 damaging generation 2. Their green runs fence failure and vector writes with the complete revision. Embeddings and their completion marker are written under the active workspace row lock. `embedding-failure-retry-green` proves PostgreSQL content remains active after a model error and a retry can finish from that snapshot even after its Git remote has been deleted.

The existing external model boundary already rejects incomplete responses and empty vectors: the exploratory `incomplete-embeddings-red` and `incomplete-vectors-red` runs passed without a product change. Their names describe the attempted repro, not evidence of a failure.

`index-failure-state-red` reproduces an unavailable index repository being reported as ready. `index-failure-green` records the error separately without changing active documents. `independent-derived-state-red` then proves an embedding write erased that index error. Atomic JSON field merges preserve independent results; `independent-derived-state-green` passes all 10 native Git/PostgreSQL/OpenWorkflow hydration contracts without exclusions. The first `index-failure-red` assertion used an incorrect snapshot property and is fixture-debug evidence only.

The revision schema changed the text of four pre-existing retraction-fixture type diagnostics. The fixture now declares the actual schema-aware `Db` type, and those four allowances have been removed instead of accepting changed diagnostics. The complete backend check is being rerun. These are intermediate proofs; index/search identity integration, full verification, and independent terminal reviews remain outstanding.


`revision-derived-typecheck` passes the complete backend with 168 existing diagnostics and no new identities. `github-native-tip-explicit-red` proves GitHub metadata lookup returned null despite a readable native repository; `github-native-tip-green` uses the shared native read policy. The earlier unhandled-request variant is fixture-debug evidence. `github-noop-credentials-red` fails a completed same-SHA hydrate when the token provider is unavailable; the green run passes all 15 Git/hydration cases after credential resolution moves behind the actual read requirement.

`search-revision-path-red` runs the backend search gateway and the real codesearch Hono app/auth/PostgreSQL routes in-process, substituting only Zoekt's third-party HTTP result. It proves search exposed commit B while PostgreSQL published commit A. `search-revision-green` reads membership and checkout SHAs in one SQL snapshot, checks each Zoekt file's Version against that published snapshot, rejects B, and serves A. The test is added to the required contract lane. The original search-revision-red had an incorrect cross-service import and is fixture-debug evidence only. Zoekt's FileMatch.Version contract is documented in https://github.com/sourcegraph/zoekt/blob/main/api.go.


## Characterization replacement in progress

The full backend inventory (`revision-search-backend-suite`) ran 1,489 cases: 1,472 passed and 17 failed. Sixteen failures referenced deliberately replaced interfaces or the obsolete expectation that write/index errors change hydrate status; one is the unchanged Gate 0 mocked chat assertion. Raw inventory/results are preserved. No new failure is allowlisted.

The real producer contract (`immutable-hydrate-enqueue-contract`) verifies that the production enqueue API stores complete revision identity through OpenWorkflow's public PostgreSQL backend API, and that a later generation change does not rewrite its queued input. The fixture cancels and deletes only its own queued command. `unresolved-tip-state-red` exposes the missing initial failure state; the green run persists failure against the exact observed generation/remote/connection/nullable SHA/branch target, without inventing a revision. `read-independent-of-write-state-contract` proves real hydration for both read-only and writable repositories before any export.

These contracts replace the owned-mock enqueue/hydrate test files. Native branch/default/rewind contracts replace two provider-call assertions in github-workspace-tip.test.ts. The write-workflow assertion requiring a write error to overwrite hydrate state was removed as contrary to Gate 2's authority rule; the 12 real write-workflow failure characterizations remain for Gate 3. The index workflow's old mock tests are still being replaced after its real derived-failure proof is complete.

The first Bun contract attempt stopped before executing tests due to Zod/Vitest module interop. Reusing codesearch's existing inline-Zod test configuration makes all 11 then-existing hydration/search contracts pass under Bun (`revision-search-bun-inline-zod`). This is test-loader configuration, not a production dependency or test exclusion.


`index-child-visible-failure-red` reproduces a real failed repository-index child leaving the parent's derived index marked ready. The green run captures the parent's complete revision in the child and records actual I/O errors against it. Error handling is inside the step's I/O callback, so native OpenWorkflow sleep/resume signals are never intercepted as failures. Initial probes timed out while the old durable credential step applied OpenWorkflow's ten-attempt default retry; those are exploratory logs, not the state-failure proof. The fixture has two worker slots for the parent/child topology.

Index credentials are now transient workflow-local values rather than persisted step output. `index-read-credential-red` additionally exposes the broad token request on the old index path; its replacement uses the captured revision's repository-scoped read policy. The five owned-mock workspace-index tests have been removed: the real missing-repository and child-I/O-failure contracts replace their hydrate-error expectations, and the child credential test proves connection fallback and I/O outside org SQL transactions. A repository-index characterization assertion naming the removed credential-persistence step was deleted; its other legacy assertions remain until Gate 6.


`index-read-credential-green` passes the real child workflow with the exact repository/read-only token request. `revision-search-backend-replacement-suite` passes the full discovered backend suite under the original single Gate 0 failure allowance; no new failures were accepted. Its inventory and structured report are preserved separately from the earlier failing run.

The cross-service contract pulled actual codesearch sources into the backend typecheck. It exposed conflicting LangGraph declarations for the root Zod and zod/v4 aliases, plus the 11 previously allowlisted codesearch DB/directory diagnostics. Removing the local OpenAPI workaround alone did not resolve the conflict (`revision-search-native-types`); the attempted alias bridge also left errors (`revision-search-native-alias-types`). A type-only pnpm patch keeps the deprecated plugin on zod/v3 and the native v4 registry on the same root alias as OpenAPI. The broad local metadata augmentation is deleted. Scoped Drizzle transaction types and string directory-entry types fix all 11 codesearch diagnostics. Native OpenAPI inference also identifies six pre-existing conversation-route success-status errors; explicit HTTP 200 annotations fix those without changing runtime behavior.

`native-zod-patch-frozen-install` succeeds offline with the lockfile frozen. Only the new patch and its LangGraph dependency references are retained from pnpm's generated lockfile; unrelated peer re-resolution is discarded. No package versions change. The patch modifies only four declaration files, preserving runtime code and native metadata types.

## Complete index identity

`index-revision-identity-red` reproduces accepting an outdated default branch at the same generation/URL/SHA. The green native workflow test rejects that command using the full captured revision. Production index enqueues capture the same value; schema refinements reject contradictions between the revision and transitional job fields.

`index-generation-freshness-red` proves a new generation inherited ready index status from a SHA-only marker. The green test removes that fallback: an active revision needs its own derived result. The fixture explicitly seeds the independent index result only for initial no-op hydration checks. `index-generation-enqueue-red` then proves hydration failed to queue that new generation because it still compared only SHA; its green test reads the real durable queue and finds the full generation-2 revision.

`revision-generation-contracts` passes all 39 cases in eight required contract files, with no failures or skips. Structured reports and discovery inventory are preserved. Complete derived-index publication, all revision readers, migration upgrade verification, final CI, and independent terminal reviews remain outstanding. Gate 2 is not complete.


## Published file reads and native type correction

`published-file-read-red` proves file browsing depended on a mutable codesearch checkout even with an active PostgreSQL revision. `published-file-read-green` lists and reads the captured native Git revision while a new generation points at an unavailable replacement. The HTTP explorer now passes the published revision into its file commands instead of computing and discarding SHA. Projections without complete published identity return 409 until hydration completes. The five old checkout-read mocks are removed: native tree/content/missing-file behavior replaces their read assertions, and codesearch availability is no longer a prerequisite for published file reads.

The complete UI typecheck (`native-route-ui-complete-types`) has 237 existing diagnostics, down from 391, and no new identities. Fixes preserve chained Hono connector exports, supply optional query objects, use the existing API transport for user-level onboarding, remove a stripped conversation query field, and complete repository fixtures. No route or component behavior is hidden with casts or new allowances. `native-route-ui-suite` passes all 291 tests in 61 files with no skips.

The full backend run `revision-generation-backend-suite` exposed the obsolete owned-mock index-enqueue assertion. Its real replacement is the durable generation-2 queue receipt above. The subsequent replacement run had one Notion discovery import exceed its existing five-second timeout while full typechecks and suites ran concurrently; neither the timeout nor its assertion is weakened. A complete run without competing typechecks is retained separately.

The host codesearch attempt lacked Zoekt binaries and reproduced an order-dependent SCIP process mock. The first Linux attempt requested an unavailable AMD64 variant of the existing ARM64 image; it did not execute tests. The ARM64 run then reproduced the same process-order failure and an old image Vitest config missing inline Zod. The final Linux run mounts the current source, scripts, and config and runs without rebuilding or pulling.

Six real Bun subprocess/file contracts replace the old SCIP process mocks: separate concurrent outputs, two-process admission and release, default-output serialization/publication, actual SIGKILL, empty shard, and non-file shard. Only third-party indexer executables are substituted; the owned runner, semaphore, streams, and filesystem execute. No production indexer behavior changes. `revision-codesearch-native-replacement` passes 178 Node plus 43 Bun cases (221 total in 34 files), with no failures or skips. The new native file is explicitly included in the existing Bun discovery partition.

### Native discovery and Files HTTP replacement

The full backend run reproduced the Notion import timeout without a competing
TypeScript process. The replacement contract runs the real OpenWorkflow `doctor`
command, inspects the actual configured directory, and asserts the exported
workflow names. `native-workflow-discovery-green` passes. The obsolete Notion
and Slack owned-client/import-only tests were removed; no timeout allowance was
added to the backend suite.

`published-files-http-queue` passes four native contracts through authenticated
Hono route fixtures, real organization/RLS models, PostgreSQL, native Git, local
sandbox processes, and the durable OpenWorkflow queue. Only GitHub's remote API
uses synthetic responses and an ephemeral fixture signing key. These replace
sixteen old Files cases in `workspaces.test.ts` (fifteen failed after the revision
change; the traversal case still passed). Coverage maps to published SHA/remote
reads during relink and remote advancement; non-GitHub/no-connection reads;
text/binary/missing/traversal responses; unpublished and legacy 409 responses;
clean and actual dirty sandbox status; read-only and invalid write rejection;
and a durable file-save command carrying the literal requested edit payload.
The old codesearch checkout-not-ready assertion is superseded by the explicit
unpublished-revision 409 contract, because file reads now use native Git.

The first HTTP attempt could not connect to local PostgreSQL inside the sandbox
(`EPERM`); the authorized native run passes. This is environment evidence, not a
product red/green failure. The queue contract proves durable admission only;
the existing Gate 3 write-execution failure and desired-versus-published write
base remain open. Gate 2 is not complete.

The full backend replacement suite (`published-files-backend-suite`) reports
1,460 cases: 1,459 pass, the single unchanged Gate 0 chat allowance, and zero
skips. `published-files-all-types` found only a missing `twoFactorEnabled` field
in the new authenticated-user fixture; the fixture was completed without casts
or an allowance. `published-files-backend-types` then passes at 155 existing
backend diagnostics. The other six full projects pass in the all-project run:
UI 237 existing, codesearch/CDK/CLI/self-host/docs zero. Native Zod exports and
complete route types account for the earlier diagnostic reduction.

`native-git-userinfo-red` reproduced that an HTTP URL containing credentials
reached Git when no separate token was supplied. `native-git-userinfo-green`
passes after validating embedded credentials before repository acquisition;
SSH usernames and local paths remain valid. Only synthetic fixture credentials
were involved. The full required contract lane follows this change.

Checkpoint validation: `published-files-required-contracts` passes all 46 tests
in 10 required files, zero skips or allowances. Proof policy checks 430
source/config files and 27 command files; source whitespace checks pass. This is
a partial Gate 2 checkpoint, with index publication/identity cleanup and the
terminal adversarial reviews still outstanding.

### Native index publication, search, and credential binding

Checkpoint `d5805ee87410d4eea1e663c4fbaa42029972e953` was pushed and its remote
branch SHA verified exactly. It remains a partial Gate 2 checkpoint.

`native-github-policy-callers-red` reproduced provider-specific branch lookups
returning no result for an otherwise readable Git remote.
`native-github-policy-callers-green` passes through both GitHub policy wrappers,
including a default-branch rename, after routing them through the shared native
read-tip policy.

The new `index-workflow.contract.test.ts` runs real OpenWorkflow parent/child
workflows, PostgreSQL/RLS models, a Bun subprocess serving the production
codesearch Hono app, native Git, Zoekt indexing, and the real Zoekt RPC service.
No owned collaborator is mocked. The initial integration run exposed completed
index work leaving canonical freshness pending. Index publication now records the
full captured revision and checks `searchIndexOk`; a real output-directory
failure records failed freshness, preserves the active projection, returns
`published: false`, and recovers on a later successful index command.

Native search exposed a second defect: the previous July Zoekt CLI ignores
branch metadata when adding documents, so file matches omit `Version` even when
the repository metadata has a branch. The indexer now includes the native Git
HEAD in branch metadata, and Docker/CI pin Zoekt to
`596c362fcf1388fe0082acfcfc80c4d172efb7c1` (module
`v0.0.0-20260907153830-596c362fcf13`), whose CLI adds those branches to indexed
documents. This behavior was checked against the actual pinned Go source and
executables, not inferred only from current upstream docs:
https://github.com/sourcegraph/zoekt/blob/596c362fcf1388fe0082acfcfc80c4d172efb7c1/cmd/zoekt-index/main.go
The macOS and Linux ARM64 binaries were built from this same revision in the
existing isolated codesearch toolchain. Backend CI installs the same pinned
native tools; the required prerequisites fail if either is absent.

Fixture corrections are retained as evidence: the first cross-build lacked the
module sources; the next lacked command dependency checksums. The successful
isolated build resolves declared module dependencies. The first native server
fixture omitted production's `-rpc` flag and returned HTML; that attempt timed
out. Its exact two subprocesses and disposable org/workflow/directory were
removed, the flag was corrected, and teardown is now also registered with
Vitest's on-test-finished hook. A one-second wait in the newly added rejection
fixture was shorter than OpenWorkflow's ordinary poll cycle; its result wait is
now ten seconds while retaining the literal rejection and untouched-state
assertions. No existing suite timeout or allowance was changed.

`native-index-child-identity-green` proves native queue admission rejects a
contradictory generation. The schema also binds SHA, access, remote, workspace,
and explicit credential connection. `native-index-repository-binding-terminal`
proves the worker rejects a different repository row without poisoning the
valid projection's freshness. Repository read binding is now a scoped database
read independent of default-checkout readiness. All index credentials use the
shared repository-scoped read policy, and the owner index keeps the connection
captured in its immutable revision.

`native-index-unbound-published-state-red` reproduced an unbound repository index
marking an unhydrated Workspace indexed by matching its Git URL. The first
fixture attempt tried to create duplicate Workspace URLs, which the actual DB
constraint correctly rejects; the final fixture uses an existing default
checkout and one unhydrated Workspace. `native-index-unbound-publication-green`
passes after removing that publication path. Its now-unused helper, model
fan-out, and `indexPublishTargets` reconstruction were deleted. The obsolete
owned-mock repository-index tests and four pure fan-out cases were removed;
the real workflow success/failure/retry/identity/publication contract and the
existing native SCIP process contracts provide replacement evidence.

Gate 2 remains open. Linked-target snapshot/CAS coverage, remaining identity
migration, the required Kubernetes ingest memory gate after the Zoekt change,
complete regression checks, and terminal independent reviews are outstanding.


### Native index, linked identity, and tip refresh follow-up

`native-index-backend-replacement` passed the backend gate: 1451 cases, 1450
passing and only the existing Gate 0 chat characterization failure. The native
Git branch/default-branch/rename proof replaced two obsolete Octokit branch
lookup assertions. `native-index-required-contracts` passed all required
contracts; `native-index-linux-codesearch` passed the full Linux suite with image
`sha256:9979e222a076898f448cbb59706efa629bf66258125053e52c48e790130d00c2`.

Native queue admission now requires a link ID for linked indexing. The parent
captures link URL, ref, and SHA in a durable step before running the index child;
completion compares both this link snapshot and the complete published owner
revision in Postgres. `native-index-linked-admission-red` reproduced malformed
admission and `native-index-linked-revision-red` reproduced stale publication
after a branch identity change. `native-index-linked-revision-green` passes.

`native-search-subset-red` reproduced an unrequested linked repository file in
a selected-repository response. `native-search-subset-green` passes with the
returned file set fenced by both selected repository and published SHA. Native
Git reads now require exactly 40 or 64 hex characters and propagate actual blob
read failures. The old catch-all reported oversized blobs as missing;
`native-read-error-classification-red` reproduces this, and
`native-read-errors-green` passes with genuine missing paths still represented
as missing and symlinks still read as blobs.

Scheduled tip checks use the shared native revision policy, including the
explicit credential connection and default branch. Capture now compares the
observed branch metadata as well as generation, URL, SHA, and connection, and
atomically updates SHA and branch together. The scheduled workflow awaits its
follow-up queue admissions. The obsolete URL-only cron reconstruction/retry
helper and its two synthetic cases were deleted. Native proof
`native-tip-metadata-green` covers a default-branch rename at unchanged SHA,
retaining the previous published projection, followed by a true same-tip no-op.
`native-tip-deleted-workspace-red` reproduced scheduled work failing after the
workspace was deleted; the policy now discards that missing target, and the
native contract plus unchanged cron regressions pass. Full backend typecheck
`native-tip-types-fixed` passes at the shrinking baseline of 155 diagnostics.

`migrate-revision-fresh-and-upgrade` passes on two disposable databases: the
complete current schema from scratch, and migration from Gate 1's exact d878
schema with a populated legacy Workspace. New identity columns remain nullable
and the legacy SHA/projection remains unchanged. Both databases were dropped.

The manual Kubernetes ingest gate was repaired to use a real disposable
Postgres organization, repository, and checkout; its old no-op database could
not support the current phase transaction. It now accepts an explicitly
identified prebuilt image, logs that image digest, validates the persisted
checkout SHA, and can keep Go cache/build files on host-backed storage. Memory
ceiling, native Kubernetes SHA, merged/language SCIP artifacts, cold shards,
and empty hot-directory criteria are unchanged. The first run exhausted
Docker disk during Go compilation, causing one concurrent native contract to
fail on Postgres ENOSPC; that is a fixture/infrastructure failure, not a product
red. Only that gate's container and identified disposable recovery build cache
were removed, restoring 5.9 GiB of Docker space. Its exact fixture rows were
cleaned. The branch-rename product red was then reproduced independently.
The memory gate rerun and final regression checks remain in progress.

Gate 2 is still open. The reader audit found chat graph tools still using the
legacy FalkorDB projection despite the new Postgres graph authority. That path,
remaining reader/identity cleanup, and the two terminal reviews must be completed
before declaring Gate 2 done.

`native-tip-backend-fixed` passes: 1449 cases, 1448 passing, only the unchanged
Gate 0 chat failure. `native-tip-types-fixed` passes at 155 diagnostics. The
portable checked-in migration proof also passes (`migrate-revision-portable-proof`).
The first host-cache memory run hit the recorder's self-imposed 600-second
limit while native Go compilation was still active (~4.3 GB cgroup memory),
not a memory-gate assertion. Its fixture was cleaned. The recorder now permits
3600 seconds for this explicitly expensive manual gate; the rerun uses the
preserved disposable Go compiler/module cache and the same memory ceiling.


### Captured chat graph and search projection

The verified indexing/tip checkpoint is `f12845bc572a53ba9221f4285dc9242ec979a434`
(local and remote). Its mandatory contracts passed 48/48.

`native-index-kubernetes-memory-complete` passes all manual memory criteria:
Kubernetes `0f29094e5b73085e3802ecc1298ecae13866bfe6`, native Zoekt plus Go SCIP,
non-empty merged and Go artifacts, cold-only Zoekt shards, empty hot directory,
real persisted checkout SHA, and exit 0. The measured cgroup peak was
5,745,840,128 bytes (about 5480 MiB) under the unchanged 5670 MiB ceiling.
The invocation used the recorded pinned image and a disposable host-backed Go
compiler/module cache. No memory ceiling was raised.

The reader audit found Workspace chat graph tools still querying FalkorDB while
hydrate had moved the graph to Postgres. `native-chat-graph-postgres-red`
reproduced `graph_unavailable` for successfully published data. Graph lookup and
neighbors now use the existing pure `workspaceGraphFromUnits` transformation of
one captured Postgres projection. `native-chat-graph-snapshot-green` proves both
directions of traversal, unknown-node isolation, schemas and membership, empty
projections, and a captured graph remaining consistent after a later activation.
The same database snapshot carries revision, units, and embeddings; the old
separate chat-unit getter and Workspace-specific FalkorDB writer/read helpers
were removed. The general org claim graph remains separate and unchanged in
purpose. The obsolete mocked Workspace graph/membership cases were replaced by
the real Postgres contract; input-policy tests remain pure.

`native-chat-search-revision-red` reproduced chat search selecting an unrelated
repository default checkout and returning `repository_not_found` despite a live
published Workspace index. Chat lexical and symbol searches now call the shared
published-revision search policy and bind it to the chat's captured projection.
`native-chat-search-revision-green` passes against real OpenWorkflow, Git,
Postgres, Bun codesearch HTTP, and Zoekt. The scheduled/native fixture also checks
that a captured chat search rejects a later identity at the same SHA.

The existing outer chat catch-and-empty compatibility behavior is retained for
Gate 4's explicit lifecycle/error-path replacement; no graph tool catches an
unavailable derived Workspace graph anymore. The native hydration fixture uses
the new snapshot getter. One regression run encountered transient Postgres
ENOSPC on three relations and timed out its hundred-file workflow; subsequent
inspection found Docker healthy with 5.9 GiB free and the memory gate writing
only ~98 KB to its container layer. This is recorded separately from the
obsolete getter fixture correction and existing chat characterization failure.

Gate 2 still requires the remaining reader audit and independent terminal
reviews. In particular, mutable `ws:<workspaceId>` checkout artifacts can advance
before activation; SCIP and structural-search wrappers still need an immutable
revision checkout binding, and linked-ref activation must clear stale index
freshness. Webhook tip producers and surviving metadata readers also need their
final full-identity audit. Gates 3–6 remain outstanding.

`native-chat-projection-required` passes all 49 native contracts across 12 files.
`native-chat-projection-types-fixed` passes at the shrinking backend baseline of
155 diagnostics. `native-chat-projection-backend` passes its gate with 1442 cases,
1441 passing and only the unchanged Gate 0 live-chat failure. Raw suite results
and proof inventories are retained alongside each invocation.

### Immutable codesearch checkouts (in progress)

Chat projection checkpoint `d150b03a767a959f75c4b7a54ac30d082ff01e97` was pushed
and verified on the authorized recovery branch. `native-index-previous-revision-red`
reproduces loss of published search after indexing a newer commit. Immutable
checkout keys and signed repository/SHA claims fix it; `native-index-previous-revision-fixed`
passes the actual Git, OpenWorkflow, Postgres, Bun HTTP, and Zoekt journey.

`native-chat-scip-revision-red` and `native-chat-structural-revision-red` reproduce
Workspace tools incorrectly requiring a repository default checkout. Both now
use the captured published membership with signed revision requests through the
shared codesearch gateway. `native-chat-scip-revision-green` and
`native-chat-structural-revision-fixed` pass. SCIP proof uses a real wire-format
SCIP fixture and production query engine; structural proof runs native ast-grep
against JavaScript files that differ between the published and unpublished
commits. The first structural rerun used `.txt`, which ast-grep correctly ignored;
that was a fixture correction, independently of the reproduced product failure.

Signed target admission, linked-ref freshness, remaining producer audit, full
regressions, the manual memory rerun, and terminal reviews remain outstanding.

`native-revision-authorization-and-link-red` reproduces HTTP 200 when a signed
published SHA is paired with a different requested target. Both native phase
admission and the monolithic compatibility route now reject that contradiction
with 403 before mutation. `native-linked-ref-index-freshness-red` reproduces an
existing normalized link retaining its old indexed SHA after a branch change;
the green contract verifies the same link id retains its membership but clears
both desired/indexed SHAs. `native-revision-authorization-and-link-green` passes
both native contracts.

`native-revision-checkout-linux-fixed` passes all 219 Linux codesearch cases
(176 Node plus 43 Bun, 34 files, zero skipped). The first Linux run retained two
obsolete checkout-row mock assertions and hit a timing-sensitive existing pin TTL
assertion under host load. The rerun passes; the two mutable-checkout mock cases
were replaced by native signed HTTP/Zoekt assertions. Dead checkout-injection and
membership-check helpers and their obsolete unit cases were removed.

The initial backend type run found five errors: two JSON Schema adapter types
and three now-unneeded repository metadata fields passed to the graph gateway.
Those are corrected. A superseded recursive public-schema type check was stopped
for the narrower adapter rerun; no diagnostic allowance was expanded.

Reader audit: the Files listing and Graph pane each select published knowledge
units in one statement and derive their response from that result; the earlier
Workspace lookup contributes only identity/authorization. The retry endpoint is
an explicit request to retry the current Workspace and captures the updated row
returned by its UPDATE, rather than publishing a queued revision. Remaining
producer work includes eliminating duplicate webhook tip persistence in favor of
the existing durable tip-check workflow and fencing linked-tip updates to their
captured link/owner/connection identity. Gates 3–6 still own write-command,
conversation lifecycle, UI, and final cleanup acceptance.

`native-revision-checkout-required-fixed` passes all 49 mandatory native
contracts across 12 files. The previous run exposed one older native fixture
using mutable checkout keys; it now also proves multi-repository search with
different published SHAs. `native-revision-checkout-backend-types-adapter`
passes with exactly 155 acknowledged diagnostics and no additions. It took
450 seconds under current host load; the process completed before attempted
profiling, so no inspector was enabled. Full backend regression and the new
image memory rerun remain before this checkpoint is verified.

The first complete backend regression run executed 1440 cases: 1427 passed,
13 failed, zero skipped. Twelve failures were timeout-related (5-second
health/auth/model-provider cases, the native index deadline, and OpenCode
readiness); the thirteenth is the unchanged Gate 0 chat failure. The entire
backend suite is rerunning with `--maxWorkers=2` to reduce local contention.
The same required inventory and existing failure checker will verify that run;
no deadlines, test selection, or failure allowances were expanded. This is a
reviewable implementation checkpoint, not terminal Gate 2 completion.


## First review: complete binding and snapshot fixes

The initial Standards and Spec reviews of `45c9c1d583a95a74dccf86ec480f8ad30cccf2b9` are preserved under `reviews/`. They were not terminal reviews. Native PostgreSQL red/green contracts reproduce and fix connection-only relink, linked-ref tip publication, and membership rereads after a chat snapshot. Workspace connection changes now advance generation, clear desired SHA/default branch, and schedule the same lifecycle work as a URL change. The canonical remote uses `connectionId`; provider-specific columns remain temporary model mappings.

`LinkedRevision` carries its full owner, link, repository, ref, connection and SHA through queue admission, credential resolution and publication. Workspace index jobs require the canonical value rather than reconstructing it from primitive job fields. Linked tip resolution uses the common native Git credential policy. The webhook's duplicate tip writers are deleted; the real signed HTTP contract observes the durable OpenWorkflow tip-check command and unchanged desired metadata. The remaining write-workflow callers now use full-identity capture instead of the removed SHA-only persistence helper.

Chat units, vectors and repository membership now come from one PostgreSQL statement. The query returns one workspace row with aggregated units and repository revisions, avoiding multiplication of unit payloads by checkout rows. Search-only callers omit unit payloads. Explorer tools retain the captured set across later publication or membership changes. An initial aggregate query failed because Drizzle dequalified correlated columns; `snapshot-query-check` records the failure and `snapshot-query-qualified` proves the explicit qualifiers with PostgreSQL and native codesearch.

Codesearch rejects workspace tokens without immutable revision claims or an explicit read-only `legacyWorkspace` discriminator. Clone and index share target admission. The native HTTP contract replaces implicit-scope assumptions. Five owned-mock cases expecting the retired mutable scope are removed; immutable index, SCIP, structural, request-override and legacy-missing-checkout behavior are exercised by the native index contracts.

Review-stage fixture extraction replaces the 17-way hydration flag journey with 23 named behavior tests and the single index journey with 16 named tests. Shared fixtures own native Git, PostgreSQL, OpenWorkflow, Zoekt and Bun lifecycles; named cases retain the 100-file budget, rewind, rollback, credential failure, relink, publication and explorer assertions. `named-hydration-contracts` and `named-index-contracts` both pass. The expanded mandatory inventory now also requires binding-race, signed-webhook and real-transaction gateway contracts.

Checkpoint CI run `34189354106` passed 12 of 13 jobs. The test job's additional failure was a missing `ast-grep` binary on the backend runner; CI now installs the codesearch image's pinned `@ast-grep/cli@0.45.0`, and prerequisites fail early if it is missing. The existing unrelated chat failure allowance was not expanded. The full backend type check shrank from 155 to 154 diagnostics with no new identity or count.

The Kubernetes ingest on the immutable-checkout image completed with valid cold Zoekt and SCIP artifacts, empty hot storage, and a measured peak of 5,161,394,176 bytes under the unchanged 5,670 MiB ceiling. Its final cleanup exited 1 due to a container-created directory's permissions; that failed harness result is preserved. The cleanup now repairs only its own temporary bind mount before removal; a clean final rerun is still required. Gate 2 remains open pending complete current-SHA checks, push verification and both terminal reviews.

`reviewed-required-contracts` passes all 77 required tests in 16 files with zero skips. `reviewed-linux-codesearch` passes all 215 tests in 34 files (173 Node, 42 Bun). The expanded native HTTP auth test also exposed codesearch's logger ignoring `createApp(env)` and rereading the process environment; passing the supplied environment fixes that native failure. Two owned-mock no-op write cases invoking the deleted SHA-only writer are retired; the mandatory real OpenWorkflow write-failure characterization remains unchanged and must be replaced in Gate 3. No write-gate completion is claimed.

A final caller audit found `persistIndexedSha` had no production callers and survived only as hydration fixture setup. It and the unused partial-identity activation/index/tip helper functions are deleted; the history fixture now captures a complete revision once. Only the explicitly documented legacy chat sandbox key remains for Gate 4. The native publication, rollback, rewind, default-branch and signed-webhook proofs replace those retired pure characterizations.


## Review-fix candidate verification

The complete seven-project type command `reviewed-all-project-types` passes: backend 154 and UI 237 acknowledged diagnostics, all other projects zero, with no expanded allowance. `reviewed-ci-command-tests` passes five command suites. `reviewed-retired-helper-policy-command` checks 433 test/story/config files and 27 command files; its preceding invocation used an incorrect script filename and is retained separately. After the final dead-helper deletion, `final-retired-helper-contracts` again passes all 77 cases in 16 files; report and inventory are preserved.

The final production image is `sha256:76607d4e521ddc25e8bf2824731f141c7652467bc3c3bd8c8c49820729ca273d` (`ctxpipe-codesearch:gate2-reviewed-final`). Its Kubernetes v1.36.3 ingest produced cold Zoekt and nonempty merged/Go SCIP, kept hot storage empty, and peaked at 5,103,169,536 bytes below the 5,670 MiB ceiling. The wrapper still exited 1 because Docker Desktop could not chmod host-owned read-only Git pack files. Cleanup now first repairs/removes host-owned files on the host and uses a root-container fallback for Linux-owned directories. The exact two completed fixture directories from the recorded logs were successfully removed using that cleanup; shell syntax passes. A full clean rerun and exact-pushed-SHA CI/reviews remain before terminal Gate 2 acceptance.

`final-retired-helper-backend-types` passes after the deletion at the unchanged 154-diagnostic baseline. No current type diagnostic is newly allowed.


## Second independent review (candidate 6d0f0709)

Candidate `6d0f0709acf9bab60caa09813e2086251aa679aa` was pushed and its remote SHA verified. CI run `34191934320` passed all 13 jobs; the complete job record is `logs/ci-6d0f0709-complete.json`. The final full Kubernetes harness `final-host-cleanup-kubernetes-memory` exits 0 including cleanup, with peak 5,484,331,008 bytes below 5,670 MiB on the unchanged final image. Both second independent review reports and their requirement/coverage supplements are retained under `reviews/`. They found additional blockers, so Gate 2 remains open.

Post-candidate fixes: `duplicate-create-relink-fixture-red` reproduces stale generation in both existing-URL create and an observed PostgreSQL unique-index race; `duplicate-create-relink-green` passes after the raced create re-enters the same locked existing-URL path. The first two red attempts had a wrong runner path and then fixture URL/result-shape mistakes; those remain recorded separately. `hydrate-resolve-null-red/green` proves initial and generation-2 hydrate resolve a missing tip without a cron dependency. `stale-index-retention-red/green` proves search keeps the complete previous index while a newly active revision's index is pending or failed. The phase record now retains the full published index revision independently of current derived status; index failure no longer clears the prior indexed SHA. `cron-full-revision-retry-red/green` proves cron retries a same-SHA replacement by canonical ProjectionState and derived results. Dead backend explorer and hydration reconstruction helpers and their obsolete tests are removed; live UI compatibility helpers remain owned by Gates 5–6.

`connection-lifecycle-revision-red/green` proves connection deletion advances the owner generation and clears unresolved tip metadata, and both deletion and shared-repository rebinding invalidate linked desired/indexed SHAs in the same transaction. The former published owner index remains available. `second-review-backend-types-green` passes with the finite allowance reduced from 154 to 148; no new diagnostic was accepted.

Remaining second-review work: immutable local checkout Files/glob/get-file reads without remote fetch on hot requests; per-file introducing commit timestamps for missing valid_from (including SHA-256 IDs); restore the locked revision-scoped Falkor graph derivation and freshness/error contract; split multi-behavior native chat/Files/search fixtures; consolidate duplicate checkout key construction and delegation-only Files wrappers. The recovery plan and locked design still require Falkor; the current PostgreSQL-only graph implementation is not terminal acceptance. Every blocker must be resolved and the final pushed commit independently re-reviewed before Gate 3 starts.

`connection-lifecycle-required-contracts` passes all 85 required cases in 16 files; its exact results and inventory are archived. `files-indexed-hot-read-red/green` reproduces HTTP 502 after deleting the published remote and proves Files now uses the captured, immutable codesearch checkout. Files tree/blob and write planning select the last published index from one canonical search snapshot. The two route-only delegation wrappers are deleted. The older direct-Git hydration Files case is replaced by this stronger native HTTP proof.

`chat-indexed-file-red/green` and `chat-indexed-glob-red/green` restore both required tools and prove they keep the captured checkout after membership and remote removal. They also pass a contradictory model-supplied SHA, which cannot override the signed binding. Existing get-file formatting and glob pagination are shared with ordinary explorer tools. `files-empty-indexed-red` exposed the shared gateway treating an empty base64 string as a missing file; `files-empty-indexed-green` passes all 16 named Files HTTP cases after correcting that distinction. The earlier named run caught a change in tree ordering; the Files path response retains its original sorting.

The extracted `test/native-index-fixture.ts` runs real PostgreSQL, OpenWorkflow, Git, Bun HTTP and Zoekt, with idempotent cleanup. Files cases are split by public behavior. `indexed-read-types-green` passes the complete backend with 148 acknowledged diagnostics and no additions. Remaining second-review work is introducing-commit timestamps, derived Falkor graph/freshness, remaining chat/search contract slicing, shared checkout-key construction, and final candidate checks/reviews. Gate 2 remains open.

`indexed-read-required-contracts` passes all 98 mandatory tests in 16 files, with zero skipped or allowed failures. Exact inventory/results are archived; the proof policy checks 432 test/story/config files and 27 command files. This is an intermediate review-fix checkpoint, not terminal Gate 2 acceptance.

Checkpoint `d8b86025283f69a380e2e8b27c8266a602544628` was pushed and verified remotely. CI `34194373994` passed all six production images, Linux codesearch, migrations, packages, Biome/policy, and Terraform. Typecheck found a resolved backend diagnostic still allowed in UI and the pre-existing nullable-stream error rendered in a different union order. Both stream cases now select the nullable overload explicitly; full seven-project `introducing-dates-all-types` passes with backend 146 and UI 234 allowances. CI Tests found five obsolete owned-mock cases in workspace-create and workspace-tip-check plus the single unchanged Gate 0 chat failure. Their replacement/deletion audit is pending; no failures are newly allowed.

`introducing-commit-dates-red/green` proves each claiming file receives its introducing commit date instead of null or the hydrated tip date. Hydrate requests one native full-history fetch and one nul-delimited raw history walk for all Markdown paths, preserving paths containing newlines and avoiding per-file provider calls. Later prose-only edits do not reset the file's date. `sha256-claim-date-red/green` handles SHA-256 placeholders; the complete native hydration/Git and pure date suite passes, including the unchanged 100-file command budget. No Git write occurs in hydration.

Falkor restoration is in progress using isolated `ctxpipe-recovery-gate2-graph-20260908` on port 6398, pinned image digest `sha256:52b6583afe7b5ba6bbf5b5f0290bdaa765bd97477b310a590771dc33ebc7b5f5`. `native-graph-publication-red/green`, `native-graph-links-red/green`, and `native-graph-claims-red/green` prove actual nodes, resolved link edges, and declared confidence/windows are derived from the captured PostgreSQL projection. Full revision identity keys the derived data inside the tenant graph; a complete marker precedes the PostgreSQL ready result. `native-graph-http-fixture-red` and `native-chat-graph-source-red` expose the old PostgreSQL fallback; both green runs now read Falkor and report missing data explicitly. The initial HTTP source-red used an invalid fixture slug and is fixture-debug evidence only. `native-graph-failure-retry` passes seven cases, including a real per-test ACL write denial and graph rebuild from PostgreSQL after remote removal. The new graph suite is not yet in the mandatory inventory; snapshot/race/empty/deletion checks, CI prerequisites, remaining contract slicing, cleanup, and final review are still pending.


## Native graph and second-review correction proof

Native FalkorDB contracts now cover publication, raw claims and links, read-time decay, HTTP metadata/empty graphs, unavailable or partial data, graph-only failure, retry without Git, cron retry at unchanged SHA, deletion, captured chat revisions, and rejection of stale completion writes. `native-graph-lifecycle-green` passed 19 cases. The connection race red observed 12 connections and 11 retained after shutdown; the shared pending connection fixed the leak. `native-graph-lost-request-red` additionally reproduced a cached dead connection; the client now invalidates it on transport loss and treats already-closed shutdown as complete.

The three real cron queue/permission cases in `native-tip-write-queue-parity` replace the obsolete workflow mocks. Existing real duplicate-create/race contracts replace `workspaces-create.test.ts`. Chat and search projection contracts now name separate membership, schema, authorization and revision behaviors. Pure graph-reconstruction tests and the test-only reconstruction wrapper were removed after native HTTP/graph parity passed. `native-named-projection-contracts` passes the refactored chat/search and all hydration cases.

`graph-review-complete-types` passes all seven complete projects with backend allowance 146, UI 234, all others zero. No new diagnostic or test failure was allowed. The checkout-key wire format now has one dependency-free shared source, copied into backend and codesearch containers. The native graph service and prerequisite query are mandatory in CI. Gate 2 remains open pending final checks and independent reviews; Gate 3 owns the existing write-job execution defects, and Gate 6 owns retired graph garbage collection after conversation-lifetime proof.
