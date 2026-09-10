# Gate 6 adversarial review — reviewer B

## SHA reviewed

`aef49848bd107de6e11736b2ae2fcbc49651ce91`

Fixed point: `cffcbc82754f84d31f5506b08e65c2b688af0fb8`.
Gate 0 comparison head: `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`.

## Verdict: PASS

## Blockers
## Requirement matrix

| Gate 6 requirement | Result | Evidence |
| --- | --- | --- |
| Mandatory deterministic Playwright golden journey; missing, skipped, or failed play fails CI | **PASS** | `selectGoldenStories` resolves all 11 required exports and rejects an entry unless its built Storybook index tags include both `workspace-golden` and `play-fn`. The browser hook records success only for `storyRenderPhaseChanged` phase `played`; it has no `completed` success path. The empty failure allowance, exact totals, zero-pending check, and runner exit-code check prevent a failure or skip from being hidden. The focused regression suite passed 5/5, including a tagged required story with no `play-fn` and `completed === false`. Exact-HEAD GitHub job `102874660203` then executed all 11 named plays in Chromium: 11 passed, 0 acknowledged failures, zero skipped. |
| Keep codesearch, docs, migration-upgrade, CDK, and Terraform gates for changed surfaces; do not claim full axe | **PASS** | The full PR range from Gate 0 merge base `90720890...HEAD` changes each surface: codesearch 44 files, docs 12, migrations 42, CDK 8, and Terraform 5. `.github/workflows/ci.yaml` retains the codesearch contract job, docs production image, fresh/previous-schema migration job, CDK build plus self-host typecheck, and credential-free Terraform validation. `remaining.md` explicitly says full axe CI is not green or claimed. |
| Delete characterization once deeper proof owns it | **PASS** | `WorkspaceChatSession.test.tsx` and `WorkspaceChatChrome.test.tsx` are deleted in the reviewed range and absent from the current tree. The retained Storybook plays exercise production compose/session/chrome behavior through real components and MSW network boundaries. New UI tests in this range are pure `.test.ts` state/transport checks, not jsdom component tests. |
| Delete leftover story fixtures | **PASS** | `WorkspaceChatSession.stories.tsx` contains hydrated thread states only and has no `ComposeEmpty`. The only `ComposeEmpty` is the collection/compose story in `WorkspaceChat.stories.tsx`, matching the ledger. |
| Preserve compatibility columns and legacy checkout key until upgrade proof | **PASS** | `apps/backend/src/db/schema/workspaces.ts` retains `desired_sha`, `active_projection_url`, `active_projection_sha`, and sandbox desired fields. `shared/workspace-checkout.ts` still returns `ws:<workspaceId>` when SHA is omitted, while `apps/codesearch/src/auth/jwt.ts` retains the explicit `legacyWorkspace` authorization path. No premature compatibility deletion is claimed. |
| Compare final metrics to Gate 0 PR 280 head, not a shallow range | **PASS** | Independent `1fad841...HEAD` measurement reproduces `comparison.md`: 513 product files, +167,544/−32,649, 174 additions, and 81 deletions. Excluding tests, stories, and contracts reproduces backend 64 / 12,323 LOC → 84 / 13,885 and UI 40 / 9,051 → 43 / 9,507. The documented Gate 0 scope also reproduces as 465 commits, 801 files, +148,441/−13,326. |
| Exit: runtime owners are durable and singular; required architecture remains | **PASS** | Full-tree searches found no `ChatEngine`, `WorkspaceJobRunner`, `SandboxLeaseStore`, process-handle registry, `write-runner`, or `write-job-agent`. Chat construction uses stock TanStack `chat`, `withPersistence`, `withSandbox`, `opencodeText`, `toWebSocketStream`, and UI `useChat`; sandbox instance ownership is TanStack `defineSandbox` plus the PostgreSQL store; default-branch writes are typed OpenWorkflow workflows over native Git; files/tree/diff chrome imports Pierre. The reviewed paths do not contain a generic catch-and-empty fallback. |

## Standards notes

- `storybook-golden` has no path filter and no retry configuration. Its failure allowance is empty. The CI source test also rejects retry flags.
- `remaining.md` now names `scripts/ci/storybook-golden.mjs` as the shipping Playwright runner. Its sole `@storybook/test-runner` occurrence is historical review text describing the removed wording, not an implementation claim or dependency.
- The 11 required names appear exactly as tagged story exports. The selector's built-index `play-fn` check is the decisive oracle; the source regex is additional inventory protection rather than the success oracle.
- `dockerChatSandboxes` and `dockerImageInspects` are process-lifetime immutable policy/inspection caches, and `workspaceChatDockerOwnership.reset()` is test-visible production instrumentation. They retain no sandbox handles, lease state, or process ownership; native labels plus the PostgreSQL instance store remain authoritative. This is a nonblocking capacity/test-seam smell, not a second lifecycle owner.
- `workspace-chat-otel.ts` keeps run-keyed process-local telemetry until the stream's `finally` closes it. It does not select product state or own chat persistence, and overlapping runs use distinct run IDs. It is not a competing chat engine or correctness registry.
- The only new environment reads in the Gate 6 runner configure CI output, an optional prebuilt Storybook URL/build skip, and its local port. They are test-runner environment configuration, not product feature toggles.
- `git diff --check cffcbc82...HEAD` is clean.
- At review time the exact-HEAD CI workflow was still in progress overall. The Storybook golden job, Biome/policy checks, Terraform, docs image, backend/worker images, packages/CDK, and migration job had succeeded; this review does not claim the unfinished full CI matrix or full-axe Storybook coverage.

## Commands and observations

- `git rev-parse HEAD cffcbc82 1fad841` resolved exactly to the three requested full SHAs.
- `git log --oneline cffcbc82..HEAD` showed 59 reviewed commits; `git diff --shortstat cffcbc82...HEAD` showed 77 files, +5,876/−2,372.
- `git diff --shortstat --numstat 1fad841...HEAD -- apps/backend apps/ui apps/codesearch` produced 513 files and +167,544/−32,649.
- Independent `git ls-tree`/`git show` counts reproduced all four workspace module/LOC cells in `comparison.md`.
- `node --test scripts/tests/ci-storybook-golden.test.mjs` passed 5/5 with zero skipped.
- `apps/ui/storybook-static` was absent, so the conditional local `SKIP_STORYBOOK_BUILD=1` command was not applicable.
- Exact-HEAD GitHub Actions job `102874660203` built Storybook and ran Chromium. Its completed job log printed `PASS` for every required export and `EXECUTED 11 tests in 5 files: 11 passed, 0 acknowledged failures, zero skipped`.
- Full PR surface measurements used `git diff 90720890...HEAD`; Gate 0 scope used `git rev-list` and `git diff 90720890...1fad841`.
- Searches covered the deleted test names, `ComposeEmpty`, compatibility fields and checkout keys, forbidden owner/facade names, process registries, write runners, stock TanStack ownership calls, Pierre imports, catches, polling, module maps, and new environment reads.
- `git diff --check cffcbc82...HEAD` returned no findings.

PASS
