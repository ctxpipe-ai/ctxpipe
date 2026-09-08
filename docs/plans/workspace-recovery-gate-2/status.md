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
