# Gate 6 acceptance

Gates 0–5 are closed. This file is the Gate 6 ledger. It stays open until
two independent Sol reviews of this HEAD from fixed point `cffcbc82`
return PASS with empty blockers, then `CLOSE_GATE_6`.

## Required work

1. Mandatory Playwright proof of the deterministic UI golden journey.
   That journey is the tagged Storybook `workspace-golden` plays running
   in Chromium. `scripts/ci/storybook-golden.mjs` launches Playwright,
   opens each story iframe, and accepts only a `played` phase after
   `selectGoldenStories` requires the index `play-fn` tag. A tagged
   required story without `play` fails inventory selection. CI job
   `storybook-golden` fails the push if any required play is missing,
   fails, or is skipped.
2. Surfaces already gated when this PR’s product diff confirmed they
   changed: codesearch, docs image, migration upgrade, CDK, Terraform.
   Storybook interaction proof was the missing gate; it is now required.
   Full axe CI on every story is not green and is not claimed.
3. Characterization deleted once a deeper owner already holds the
   invariant (jsdom compose/chrome session tests). Remaining mocked
   backend characterization stays until a native contract replaces it.
4. Session `ComposeEmpty` removed. Session is the hydrated thread only.
5. Compatibility columns (`desired_sha`, `active_projection_*`, legacy
   `ws:<workspaceId>` checkout keys) stay until upgrade proof shows no
   legacy rows. That is migrate-first work, not a code-only delete.
6. Comparison versus Gate 0 PR 280 head `1fad841` is in
   [comparison.md](./comparison.md). Deletion of competing owners is in
   [deletion-ledger.md](./deletion-ledger.md).

## Golden journey (mandatory)

| Step | Story | Owner |
| --- | --- | --- |
| Home first send, Strict Mode | `FirstMessageSendsOnceInStrictMode` | collection POST once |
| Compose late error | `LateErrorDoesNotClobberSuccess` | first answer survives |
| Socket dispose | `SocketCleansUpOnLeave` | every tracked socket closes |
| Reload / reconnect | `ReloadReconnects` | hydrate + new socket |
| Rapid routes | `RapidRouteChanges` | no leaked owner |
| Edit then leave | `EditThenNavigate` | unmount flushes dirty Pierre text |
| Out-of-order saves | `OutOfOrderSaves` | distinct dirty bodies |
| Pierre keyboard | `PierreKeyboardFocus` | selected billing row, no manufactured click |
| Shared publish | `SharedPublishPending` | one pending owner |
| Stable request budget | `StableRequestBudget` | chat + Files + Diff + Publish |
| Files budget | `StableFilesRequestBudget` | files pane idle |

Live signup → GitHub App publish → Btrfs quota restart is still the Gate 0
failed baseline and the Gate 4 fail-closed Railway/Btrfs contract. This
host cannot prove that path. Do not treat a scripted Storybook journey as
a live GitHub publish.

## Review history

`f18f147a` reviews both BLOCKED on a missing-play false positive, stale
comparison totals, and leftover `@storybook/test-runner` wording. Those
are fixed in this HEAD. Do not treat the `f18f147a` reviews as closure.

## Local golden evidence

`SKIP_STORYBOOK_BUILD=1 node scripts/ci/storybook-golden.mjs` executed all
11 tagged plays in Chromium: 11 passed, 0 skipped. Results are in
`.ci-results/storybook-golden/results.json`.

## Closed work

Do not add a new environment variable, a second chat engine, or jsdom
component tests. Proof stays in Storybook `play` functions plus the
existing native backend contracts.
