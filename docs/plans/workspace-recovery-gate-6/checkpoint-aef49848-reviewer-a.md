# Gate 6 adversarial review — reviewer A

## SHA reviewed

`aef49848bd107de6e11736b2ae2fcbc49651ce91`

Fixed point: `cffcbc82754f84d31f5506b08e65c2b688af0fb8`.
Gate 0 comparison base: `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`.

## Verdict: PASS

## Blockers
## Requirement matrix

| Gate 6 requirement | Result | Fresh evidence |
| --- | --- | --- |
| Mandatory deterministic Playwright golden journey; a missing, skipped, or failed required play fails CI | **PASS** | `.github/workflows/ci.yaml` installs Chromium and runs `scripts/ci/storybook-golden.mjs` without retries. `selectGoldenStories` requires each allowlisted export to have both `workspace-golden` and Storybook's generated `play-fn` tag. A synthetic remapped `FirstMessageSendsOnceInStrictMode` entry with `workspace-golden` but no `play-fn` threw `FirstMessageSendsOnceInStrictMode is tagged workspace-golden but has no play function`. The injected browser hook records success only for `phase === "played"`; `completed` does not occur in its source. The selector regression suite passed 5/5, including explicit rejection of `completed`. The current-HEAD GitHub `Storybook Playwright golden journey` job completed successfully. |
| Retain codesearch, docs, migration-upgrade, CDK, and Terraform gates for changed surfaces; do not claim full axe | **PASS** | The `1fad841...HEAD` diff changes codesearch, `apps/docs/Dockerfile`, migrations, CDK/package surfaces, and `infra`. CI retains the codesearch real-toolchain job, docs production-image build, fresh-and-main migration job, CDK tests/build and self-host typecheck, and credential-free Terraform validation. No axe job or full-axe claim was found. At review time current-HEAD Storybook, Terraform, migration, package/CDK, and docs-build jobs were successful; codesearch was still running, so this review does not claim all CI complete. |
| Delete compose/chrome jsdom characterization once deeper browser proof owns it | **PASS** | `WorkspaceChatSession.test.tsx` and `WorkspaceChatChrome.test.tsx` are deleted in `cffcbc82...HEAD`. Their retained oracles are production-component Storybook plays/stories; new UI tests in the range exercise pure QueryClient, copy, mutation-key, and transport logic without rendering components in jsdom. |
| Delete leftover session `ComposeEmpty` fixture | **PASS** | `WorkspaceChatSession.stories.tsx` has no `ComposeEmpty`. The remaining `WorkspaceChat.stories.tsx::ComposeEmpty` belongs to collection/compose ownership, not the hydrated session, matching the deletion ledger. |
| Keep compatibility columns and legacy checkout reads until upgrade proof | **PASS** | `desired_sha`, `active_projection_url`, `active_projection_sha`, sandbox desired columns, `shared/workspace-checkout.ts`'s `ws:<workspaceId>` format, and the signed `legacyWorkspace` codesearch path remain present. The ledger correctly treats them as migration compatibility rather than deleting them without proof. |
| Compare final metrics to Gate 0 PR 280 head rather than a shallow range | **PASS** | Fresh `1fad841...HEAD` product-tree measurements are 513 files, +167,544/−32,649, 81 deleted files, and 174 added files, exactly matching `comparison.md`. Independently enumerating production `.ts`/`.tsx` files while excluding tests, stories, and contracts reproduced all module/LOC rows: backend 64/12,323 → 84/13,885 and UI 40/9,051 → 43/9,507. Request/latency text honestly retains the failed Gate 0 live baseline instead of inventing a comparable live series. |

## Standards notes

- Final-tree searches found no `ChatEngine`, `SandboxLeaseStore`, `WorkspaceJobRunner`, competing write runner, or restored deleted registry/repair module in product code. Native Git remains worktree truth; typed writes enqueue OpenWorkflow; chat uses TanStack `chat`, `useChat`, `webSocket`, and `toWebSocketStream`; tree/editor/diff chrome imports Pierre.
- `dockerChatSandboxes` and image-inspection promises are process-local immutable policy/definition interns, and `workspaceChatDockerOwnership` is test-visible instrumentation. They do not store sandbox handles or select durable ownership; PostgreSQL's native instance/lock stores do. The deletion ledger discloses them. This is a capacity/test-seam concern, not a second lifecycle registry.
- The run-keyed `workspace-chat-otel` map owns telemetry span aggregation, not chat execution or persistence. The prior conversation-key overlap problem is absent because callers propagate a run ID.
- `WorkspaceFilesPane` catches a rejected predecessor only so the next same-path write can run; the failed mutation itself records UI error state and rejects. Browser session-storage parsing falls back to the live tree. I found no infrastructure-error-to-empty chat/hydration path: non-404 hydration failures throw, and sandbox failures return explicit 409/503 outcomes.
- No product environment toggle was added. The new environment reads are test-runner controls (`STORYBOOK_URL`, port, output directory, and the requested build-skip control), not product feature switches.
- `WorkspacePane.tsx` is 633 lines and extracted `WorkspaceFilesPane.tsx` is 1,159 lines; production module/LOC totals increased over Gate 0. The recovery plan labels the 30–40%/roughly-500-line targets as guardrails, and `comparison.md` states the miss rather than claiming it was achieved. The positive deletion is ownership/scaffolding removal, not a raw-LOC win.
- `git diff --check` passed for both `cffcbc82...HEAD` and the full Gate 0 product-tree comparison.

## Commands and observations

- `git rev-parse HEAD cffcbc82 1fad841` — resolved exactly to the reviewed SHA, fixed point, and Gate 0 PR head named above.
- `git log --oneline cffcbc82..HEAD` — reviewed the Gate 5/6 commit sequence through `aef49848`.
- `git diff cffcbc82...HEAD` / name-status searches — 77 files, +5,876/−2,372; confirmed the two jsdom test deletions, session fixture change, runner/CI wiring, and retained compatibility paths.
- `git diff --shortstat 1fad841...HEAD -- apps/backend apps/ui apps/codesearch` — `513 files changed, 167544 insertions(+), 32649 deletions(-)`.
- Added/deleted product-file counts — 174 added and 81 deleted.
- Independent module/LOC enumeration — backend `64/12323 → 84/13885`; UI `40/9051 → 43/9507`.
- `node --test scripts/tests/ci-storybook-golden.test.mjs` — 5 passed, 0 failed, 0 skipped/todo.
- Direct no-play remap probe — threw `FirstMessageSendsOnceInStrictMode is tagged workspace-golden but has no play function`.
- Browser-hook source probe — only `if (phase === "played")`; no `completed` success branch.
- `node scripts/ci/check-test-policy.mjs` — checked 440 test/story/config files and 29 command files successfully.
- `SKIP_STORYBOOK_BUILD=1 node scripts/ci/storybook-golden.mjs` — not rerun locally because `apps/ui/storybook-static` is absent, as the requested conditional directs. The existing result artifact records 11 passed/0 failed/0 pending, and, more importantly, the current-HEAD GitHub golden job using the corrected selector/hook completed successfully.
- Current-HEAD GitHub CI observation — Storybook golden, Terraform, migrations, runnable packages/CDK, and docs production image succeeded; full CI remained in progress, so no full-suite or full-axe claim is made.
- Full-tree architecture/deletion searches — no second chat/write engine or deleted owner module; compatibility paths retained; required stories have 11 `workspace-golden` tags and named exports; no skip/todo/only modifier found in those story files.

PASS
