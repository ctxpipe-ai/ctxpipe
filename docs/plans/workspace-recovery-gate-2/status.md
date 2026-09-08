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
