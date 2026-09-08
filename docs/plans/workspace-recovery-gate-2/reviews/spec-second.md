# Gate 2 SPEC review — second pass

Reviewed fixed base `d87858354a783a9fd95c46785208c9b699a45e3b` through candidate `6d0f0709acf9bab60caa09813e2086251aa679aa`, including the repository-wide readers/writers and Gate 0 manifest. **Verdict: BLOCKED.**

## Missing / partial requirements

- **[P1] Credential changes still bypass revision identity.** The spec says “trace every reader and writer of revision [and] generation” and find contradictory revisions (637–640). Duplicate-create branches update `githubConnectionId` alone (`models/workspaces.ts:552–568,649–665`). Connector deletion uses FK `SET NULL` for both workspaces and repositories (`db/schema/workspaces.ts:29–31`; `repositories.ts:62–65`), while shared-repository rebinding updates only that repository field (`models/repositories.ts:256–270`). Desired generations and linked desired/indexed SHAs survive.

- **[P1] Last published search is discarded.** The locked design says “Keep serving the last complete Zoekt+SCIP index” and “Stale is ok” (issue 11:96,104), while Gate 2 requires derived search freshness (629). `projectionFromWorkspace` admits only an index result matching the active revision (`models/workspaces.ts:213–235`), the snapshot omits all others (410–437), and index failure clears `indexedSha` (1543–1546). The failure contract incorrectly expects empty search (`index-workflow.contract.test.ts:746–766`).

- **[P1] Hydrate/index start does not resolve a null SHA.** The design requires “Resolve-if-null at hydrate/index start” (issue 11:108); `resolve-revision.ts:84–87` throws unless a separate caller requested refresh.

- **[P1] Missing `valid_from` is not derived.** The hydration contract says hydrate derives the introducing-commit timestamp read-only (issue 02:64–65). `workspace-hydrate.ts:188` always passes `null`; SHA-256 placeholders are also missed by the 40-character detector (`hydrate-phases.ts:18–29`).

- **[P1] Graph freshness is absent and locked behavior was replaced.** Gate 2 says “Express embedding, graph, and search freshness as derived-store results” (629). `revision.ts:39–48` hard-codes graph as `{kind:"postgres"}`; hydrate never projects Falkor, and chat/HTTP construct an in-memory graph (`workspace-chat-tools.ts:202`; `workspace-graph-routes.ts:78`). This contradicts issue 02:50–53 and issue 13:84–92 without a reopened decision.

## Implemented incorrectly / deletion

- **[P1] `glob/get-file` are missing or use the wrong source.** The locked hot path says they use the “last published indexed SHA” (issue 11:102), and workspace chat must expose both (issue 13:84–92). Chat filters them out (`workspace-chat-tools.ts:203–209,292`); Files instead resolves credentials and creates/fetches a temporary repository per request (`checkout-read.ts:22–53`; `clone-tree.ts:103–123`).
- **[P2] Obsolete reconstruction remains**, contrary to “delete obsolete field reconstruction” (630–631): `workspaceGitExplorerTarget`, three old hydrate helpers, and two phase helpers have only test callers.

No other material unasked behavior was found. Exact-SHA CI still had two codesearch jobs pending; terminal acceptance cannot be claimed.
