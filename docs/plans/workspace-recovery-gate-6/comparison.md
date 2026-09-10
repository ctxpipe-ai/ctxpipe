# Gate 6 comparison to Gate 0

Fixed points:

- Gate 0 PR 280 head: `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`
- Gate 0 merge base: `9072089086f6fad87fbf05572b9f1ff5336e0520`
- Gate 0 scope: 465 commits, 801 files, +148,441 / −13,326
- This comparison uses `1fad841...HEAD` for recovery deltas, not the
  pre-280 merge base (that range includes unrelated later history).

## Product tree (`apps/backend`, `apps/ui`, `apps/codesearch`)

| Measure | Gate 0 PR head | Recovery HEAD | Delta |
| --- | ---: | ---: | ---: |
| Files changed vs 280 | — | 513 | +167,544 / −32,649 |
| Product files deleted | — | 81 | competing owners + obsolete tests |
| Product files added | — | 174 | native contracts, revision identity, stories |

Most of the full-branch file count is Gate 0–5 evidence under
`docs/plans/workspace-recovery-gate-*`. That is audit trail, not product
runtime.

## Workspace production modules (exclude tests, stories, contracts)

| Surface | Gate 0 modules | Gate 0 LOC | Now modules | Now LOC |
| --- | ---: | ---: | ---: | ---: |
| `apps/backend/src/domain/workspaces` | 64 | 12,323 | 84 | 13,885 |
| `apps/ui/src/features/workspaces` | 40 | 9,051 | 43 | 9,507 |

UI production did not hit the aspirational 30–40% cut. `WorkspacePane`
is composition; files, diff, chat, and publish have their own owners.
The recovery added revision/projection types and Pierre bindings instead
of shrinking the first implementation.

## Runtime owners (singular)

| Concern | Gate 0 | Now |
| --- | --- | --- |
| Chat session | compose + route + pending ID + render repair | collection POST identity; destination `useChat` hydrate |
| Sandbox | process registry + memo + health | TanStack `defineSandbox` + Postgres instance store |
| Default-branch write | write-runner + job agent + leftover commit helpers | typed OpenWorkflow job |
| Files UI | custom tree/diff | Pierre trees/diffs |
| Transport | mixed HTTP/SSE/WS repair | stock TanStack WebSocket + `dispose()` |

## Request / latency

Gate 0 golden journey never reached a clean Home → conversation → files
→ restart path (local-remote tip 503). Gate 4 native contracts own warm
prepare/send, one terminal, and quota-Docker reuse. Gate 5
`StableRequestBudget` / `StableFilesRequestBudget` own the idle UI
request budget. There is no honest live-product latency series on this
host to replace Gate 0’s failed baseline.

## Proof

Gate 0: classification TSV + failed manual journey.
Now: mandatory Chromium Storybook plays (`workspace-golden`) plus native
backend contract lanes already required by ADR-031.
