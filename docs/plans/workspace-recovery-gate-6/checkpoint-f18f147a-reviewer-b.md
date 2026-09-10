# Gate 6 adversarial review — reviewer B

Reviewed independently at candidate `f18f147a179a8e398375c116e041017087472d59`
from fixed point `cffcbc82754f84d31f5506b08e65c2b688af0fb8` with
`git diff cffcbc82...HEAD`. The Gate 0 comparison was independently recomputed
from PR 280 head `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`.

## Verdict

Gate 6 is blocked by one test-oracle defect and two inaccurate acceptance
statements. The current golden sources do execute successfully: a clean
Storybook build followed by `node scripts/ci/storybook-golden.mjs` ran 11
Chromium stories with 11 passed, 0 failed, and 0 skipped. That successful run
does not remove the runner's missing-play false-positive path.

## Blockers

1. **The mandatory runner accepts a required tagged story whose `play`
   function is absent.** `scripts/ci/storybook-golden.mjs:100-110` selects a
   requirement by export name and tag only. Its browser hook then records
   either `played` **or the generic `completed` render phase** as success
   (`scripts/ci/storybook-golden.mjs:130-137`). The policy regression test also
   checks only that the export has the tag
   (`scripts/tests/ci-storybook-golden.test.mjs:55-65`), not that it has a
   `play` function. I opened the unplayed
   `WorkspaceChat.stories.tsx::ComposeEmpty` story through the same built
   iframe/event hook; the observed result was
   `{"ok":true,"phase":"completed"}`. Thus deleting a required `play` while
   leaving its tag would keep the required CI job green, contrary to the
   ledger's promise that a missing or skipped required play fails
   (`remaining.md:9-12`) and ADR-031's same requirement
   (`ADR-031-required-recovery-ci.md:44-48`). Require an observed `played`
   phase and/or inspect the prepared story for a play function; add a
   regression that proves a tagged requirement without `play` fails.

2. **The final Gate 0 product-tree totals are stale.**
   `comparison.md:13-17` reports 513 files, +167,438/−32,285, 79 deleted, and
   173 added. At this exact candidate,
   `git diff --shortstat 1fad841...HEAD -- apps/backend apps/ui apps/codesearch`
   reports 513 files, **+167,544/−32,649**; `git diff --summary` reports
   **81 deleted and 174 created**. The module/LOC rows were independently
   reproduced exactly (64/12,323 → 84/13,885 backend and 40/9,051 →
   43/9,507 UI), and the base is correctly the full PR 280 head. Correct the
   stale product-tree figures so this is a truthful final-HEAD comparison.

3. **The acceptance ledger names a runner that no longer ships.**
   `remaining.md:9-12` says Chromium runs via `@storybook/test-runner`, but
   that dependency and `apps/ui/.storybook/test-runner.js` were removed in
   `cc947a55`; current `apps/ui/package.json:84-103` has direct `playwright`
   and `scripts/ci/storybook-golden.mjs:176-231` launches it directly. The
   direct runner is compatible with the gate's requested architecture, but the
   acceptance record must describe the implementation that actually ships.

## Requirement matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| Mandatory deterministic Chromium Storybook journey in CI | **FAIL** | `.github/workflows/ci.yaml:237-267` defines the unconditional XOR-gated job, installs Chromium, runs the script, and uploads results. All 11 required exports are tagged and the current clean build/run passed 11/11. Blocker 1 shows the job can remain green after a required play is removed. |
| Codesearch, docs, migration upgrade, CDK and Terraform remain gated; no full-axe claim | **PASS** | `.github/workflows/ci.yaml:185-235,269-348` retains product image builds (including docs/codesearch), package/CDK checks, codesearch tests, Terraform validation, and fresh/previous-schema migration. No axe/a11y job exists or is claimed in `remaining.md:13-16`. |
| Delete jsdom compose/chrome characterization after deeper browser proof | **PASS** | `WorkspaceChatSession.test.tsx` and `WorkspaceChatChrome.test.tsx` are deleted; no file or live import remains. Browser stories exercise the production `HomeComposer`, `WorkspaceChat`, `WorkspaceChatSession`, Pierre files pane, and shared publish hook. |
| Delete leftover session `ComposeEmpty` | **PASS** | `WorkspaceChatSession.stories.tsx` has thread-only stories and no `ComposeEmpty`. The sole production-tree story is `WorkspaceChat.stories.tsx:51-59`, correctly owning collection/compose rather than hydrated session. |
| Preserve compatibility columns and legacy checkout key pending upgrade proof | **PASS** | `apps/backend/src/db/schema/workspaces.ts`, `apps/backend/src/db/backfill-knowledge-path-state.ts`, `shared/workspace-checkout.ts`, and `apps/codesearch/src/auth/jwt.ts` retain the explicit migration reads. They are not treated as competing-owner blockers. |
| Compare final state to full Gate 0 PR 280 head | **FAIL** | `comparison.md:3-9` names the correct `1fad841` head and the merge base is exactly `1fad841`; module/LOC totals reproduce. Blocker 2 shows the final product-tree totals do not reproduce at `f18f147a`. |
| Exit: durable singular runtime owners and positive deletion ledger | **PASS** | Chat uses stock `chat`/`withPersistence`/`withSandbox` in `tanstack-workspace-chat.ts`; sandbox identity is `defineSandbox` plus `postgresSandboxInstanceStore`; UI session state is `useChat` plus disposable `workspaceChatWebSocket`; files use Pierre; default writes enumerate typed OpenWorkflow workflows. Searches found no surviving registry, sandbox memo/health, `write-runner`, `write-job-agent`, `tanstack-runtime`, assistant-text repair, custom port helper, or Home pending-compose module. |
| Gate 0 live GitHub App/Btrfs baseline | **NOT A BLOCKER** | `remaining.md:44-47` truthfully retains it as the failed baseline. No live publish/restart success is inferred from Storybook. |

## Standards review

- The stories remain colocated, render production components, use MSW only at
  network boundaries, and drive accessible controls in a real Chromium
  browser, matching `apps/ui/AGENTS.md` and the Storybook skill.
- The two deleted jsdom component suites comply with the repository rule that
  UI behavior belongs in Storybook Playwright interactions.
- The CI job has no retry flag, no failure allowance, and no path filter. The
  test-policy command checked 440 test/story/config files and 29 command files.
- No new environment toggle, product lifecycle owner, or compatibility
  deletion was introduced in Gate 6.
- The inaccurate ledger/metric statements in blockers 2–3 violate Gate 6's
  requirement that its acceptance and comparison artifacts describe the
  shipped final state.

No additional Fowler smell is gate-blocking. The module and LOC increases are
already stated honestly; owner deletion, rather than aspirational LOC reduction,
is the relevant architecture outcome.

## Codebase coverage

| Surface | Inspected entry points and searches |
| --- | --- |
| CI and command wiring | `.github/workflows/ci.yaml`, root/UI package scripts, lockfile, golden runner, report/failure/history checks, policy regression test |
| Golden UI path | Home first send; compose late error; socket cleanup; reload/reconnect; rapid routes; edit/unmount flush; overlapping saves; Pierre keyboard/focus; shared publish pending; stable files/full-surface budgets |
| Production UI owners | `HomeComposer`, `WorkspaceChat`, `WorkspaceChatSession`, `workspaceChatWebSocket`, `WorkspaceSurface`, `WorkspacePane`, `WorkspaceFilesPane`, `WorkspaceFileTree`, `WorkspaceConversationDiff`, `useConversationPublish`, queries and snapshots |
| Backend chat/session | conversation HTTP/WS/reconstruct routes, `tanstack-workspace-chat`, persistence, send/turn runtime, callback/model proxy, native instance/lock store, sandbox cleanup and publish/files commands |
| Default-branch writes | OpenWorkflow enqueue/admission and all typed `workspace-*` workflow entry points; repository-wide git push/credential searches |
| Compatibility/migration | workspace schema/backfill, ADR-032 references, shared checkout-key helper, codesearch JWT/auth and checkout consumers |
| Deployment/package gates | production image matrix, docs/codesearch images, codesearch lane, migration lane, CDK build/tests and self-host typecheck, Terraform validation |
| Historical comparison | Gate 0 baseline, measurements, failed golden journey, full PR head/merge-base, product diff statistics and module/LOC recomputation |
| Stale-owner deletion | Full-tree searches for `ComposeEmpty`, deleted jsdom names, pending compose, registry/memo/health, generic write runner/agent, TanStack loader, assistant repair, port owner, broad session/lease facades, globals, polling and push paths |

## Commands and observations

- `git rev-parse HEAD cffcbc82 origin/codex/develop-plan-to-refocus-branch-direction`
- `git log --oneline cffcbc82..HEAD`
- `git diff --stat --name-status cffcbc82...HEAD`
- `git merge-base 1fad841 HEAD`
- `git diff --shortstat 1fad841...HEAD -- apps/backend apps/ui apps/codesearch`
- `git diff --summary 1fad841...HEAD -- apps/backend apps/ui apps/codesearch`
- Python line/module recount with the comparison's stated test/story/contract
  exclusions
- Repository-wide `rg`/glob searches across `apps`, `packages`, `shared`,
  `.github`, `.ai/memory`, `scripts`, and `docs/plans`
- `node scripts/ci/storybook-golden.mjs` — clean build; 11 passed, 0 failed,
  0 skipped
- `node --test scripts/tests/ci-storybook-golden.test.mjs` — 2 passed
- `node scripts/ci/check-test-policy.mjs` — 440 test/story/config and 29 command
  files checked
- No-play iframe probe using the runner's own success hook — unplayed
  `ComposeEmpty` returned successful phase `completed`

BLOCK
