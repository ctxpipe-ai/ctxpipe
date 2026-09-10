# Gate 6 adversarial review — reviewer A

Reviewed `f18f147a179a8e398375c116e041017087472d59` independently from
fixed point `cffcbc82754f84d31f5506b08e65c2b688af0fb8` with
`git diff cffcbc82...HEAD`. The historical comparison was recomputed from the
full Gate 0 PR 280 head `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`.

## Verdict

Gate 6 is blocked. The current eleven golden plays pass in a clean Chromium
run, and the runtime/deletion audit is otherwise positive, but the mandatory
runner has a reproducible skipped-play false positive and two acceptance
documents do not describe this exact HEAD.

## Blockers

1. **A required tagged story can lose its `play` function without failing the
   mandatory job.** `scripts/ci/storybook-golden.mjs:100-110` requires only the
   export name and `workspace-golden` tag. Its injected browser hook treats
   both `played` and Storybook's generic `completed` render phase as success
   (`scripts/ci/storybook-golden.mjs:130-137`). Storybook 10 emits `completed`
   whether or not a play exists. The regression test checks the tag but not a
   play (`scripts/tests/ci-storybook-golden.test.mjs:55-65`). I served the
   freshly built Storybook with its index mapping the required
   `FirstMessageSendsOnceInStrictMode` entry to the existing no-play
   `NoWorkspaces` story, preserving the required export name and tag. The
   unmodified runner exited 0 and reported all 11 requirements passed. This
   contradicts `remaining.md:9-12` and ADR-031's promise that a missing or
   skipped required play fails CI. Record `completed` without a preceding
   `played` as failure (or inspect the prepared story for a play), and add a
   negative regression proving a tagged required story without `play` fails.

2. **`comparison.md` contains stale final-HEAD product totals.** It reports
   513 files, +167,438/−32,285, 79 deleted files, and 173 added files. At the
   reviewed SHA,
   `git diff 1fad841...HEAD -- apps/backend apps/ui apps/codesearch` gives
   513 files, **+167,544/−32,649**, with **81 deletions and 174 additions**.
   The comparison uses the correct full PR head, and its module/LOC rows do
   reproduce, but Gate 6 requires a truthful comparison of the final state.

3. **`remaining.md` names a test runner that is not used.** Lines 9-12 say the
   Chromium plays run through `@storybook/test-runner`; the shipping script
   directly loads `playwright` and launches Chromium
   (`scripts/ci/storybook-golden.mjs:176-231`). The direct runner is compatible
   with the requested Gate 6 architecture, but the acceptance ledger must name
   the implementation that actually ships.

## Requirement matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| Mandatory deterministic `workspace-golden` Chromium journey in CI | **FAIL** | `.github/workflows/ci.yaml:237-267` installs Chromium, runs the no-retry script, and uploads results. A clean build/run passed 11/11, but blocker 1 proves a required play can be omitted while the job remains green. |
| Codesearch, docs, migration-upgrade, CDK and Terraform gates remain; no full-axe claim | **PASS** | CI retains codesearch contracts, docs/codesearch production images, fresh/previous-schema migration, CDK package/tests and self-host typecheck, and Terraform validation. There is no claimed all-story axe job. |
| Delete superseded jsdom compose/chrome characterization | **PASS** | `WorkspaceChatSession.test.tsx` and `WorkspaceChatChrome.test.tsx` are deleted and have no surviving callers. The deeper Storybook plays render production components and substitute network boundaries through MSW. |
| Delete session `ComposeEmpty` | **PASS** | `WorkspaceChatSession.stories.tsx` contains hydrated-thread stories only. The sole `ComposeEmpty` under product code belongs to collection owner `WorkspaceChat.stories.tsx`, as intended. |
| Keep compatibility columns and `ws:<workspaceId>` until upgrade proof | **PASS** | Schema, backfill, shared checkout-key, and codesearch auth consumers retain the migration path. These are not treated as competing owners. |
| Compare to full Gate 0 PR 280 head | **FAIL** | `1fad841` is the merge base and correct comparison point, but blocker 2 shows the recorded final totals are stale. |
| Durable, singular runtime owners and positive deletion ledger | **PASS** | Chat converges on stock TanStack chat/persistence/sandbox, sandbox identity on `defineSandbox` plus the Postgres instance store, UI session state on `useChat` plus disposable WebSocket transport, files/diff on Pierre, publish pending state on shared Query mutation keys, and default writes on typed OpenWorkflow workflows. |
| Live GitHub App / Btrfs restart baseline | **NOT A BLOCKER** | `remaining.md:44-47` correctly keeps this as the failed Gate 0 baseline and does not claim Storybook proves live publish or restart. |

## Standards review

- Stories remain colocated, exercise production React components, use browser
  interactions, and mock only HTTP/WebSocket boundaries, matching
  `apps/ui/AGENTS.md`.
- The removed jsdom suites conform to the repository rule that UI behavior is
  owned by Storybook browser interactions.
- The CI job has no retry, path filter, skip allowance, or acknowledged
  failure. The defect is its success oracle, not current play execution.
- No new environment toggle, compatibility deletion, process registry, generic
  write runner, or alternate chat engine appears in the reviewed tree.
- The inaccurate runner description and stale metrics violate Gate 6's
  requirement that acceptance evidence describe the implementation and exact
  final candidate.

No additional standards or Fowler-smell finding is gate-blocking.

## Codebase coverage

| Surface | Inspected |
| --- | --- |
| CI and proof wiring | CI workflow, root/UI package scripts, lockfile, golden runner, allowlist/report policy, failure file, and runner regression test |
| Golden UI path | Home first send; late error; socket cleanup; reload; rapid routes; edit/unmount flush; overlapping saves; Pierre keyboard/focus; shared publish; files/full-surface budgets |
| UI owners | `HomeComposer`, `WorkspaceChat`, `WorkspaceChatSession`, `workspaceChatWebSocket`, `WorkspaceSurface`, `WorkspacePane`, `WorkspaceFilesPane`, `WorkspaceConversationDiff`, `WorkspaceFileTree`, queries, snapshots, and `useConversationPublish` |
| Backend chat and sandbox | HTTP/WebSocket entry points, stock chat composition, persistence/send runtime, `defineSandbox`, Postgres instance/lock state, file commands, and session publish |
| Default-branch writes | Typed OpenWorkflow entry points, enqueue/admission paths, brokered push, and repository-wide non-test push/credential searches |
| Compatibility and migration | Workspace schema/backfills, ADR-032 path, shared checkout keys, codesearch JWT/auth consumers, and migration CI |
| Deployment gates | Production image matrix, runnable packages, codesearch lane, migration lane, CDK checks, self-host typecheck, and Terraform validation |
| Deletion and stale owners | Full-tree searches for deleted test names, session `ComposeEmpty`, pending compose, registries, memo/health owners, generic runner/agent, TanStack runtime loader, port helper, globals, polling, and duplicate publish paths |
| Gate 0 comparison | Full PR head and merge base, scoped file/line statistics, created/deleted files, and production module/LOC counts |

## Commands and observations

- `git rev-parse HEAD cffcbc82 1fad841`
- `git log --oneline cffcbc82..HEAD`
- `git diff --stat --name-status cffcbc82...HEAD`
- `git merge-base 1fad841 HEAD`
- `git diff --shortstat 1fad841...HEAD -- apps/backend apps/ui apps/codesearch`
- scoped `git diff --numstat`, `--diff-filter=A`, and `--diff-filter=D`
- repository-wide `rg` searches across `apps`, `packages`, `shared`,
  `.github`, `.ai/memory`, `scripts`, and `docs`
- `node --test scripts/tests/ci-storybook-golden.test.mjs` — 2 passed
- `pnpm test:storybook-golden` — clean Storybook build; 11 passed, 0 failed,
  0 skipped
- `node scripts/ci/check-test-policy.mjs` — 440 test/story/config files and 29
  command files checked
- altered-index no-play probe — runner exited 0 and reported 11/11 passed
- genuine built index rerun after the probe — 11/11 passed

BLOCK
