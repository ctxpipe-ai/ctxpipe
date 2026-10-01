# PR 280 release tickets

Work queue for getting PR 280 (git-backed Workspaces, branch `cursor/git-backed-projects-3c79`) to production with high confidence. Tickets are added and resolved here until the board is empty and the branch merges.

This follows the repo's local Markdown tracker ([issue-tracker.md](../../agents/issue-tracker.md)) and triage labels ([triage-labels.md](../../agents/triage-labels.md)), with a plan-review step and delegation fields added.

## Layout

- [board.md](board.md) — one row per ticket. Update it whenever a ticket changes status, owner, or blockers.
- `issues/NN-<slug>.md` — one file per ticket, numbered from `01`, never reused.
- [templates/ticket.md](templates/ticket.md) — copy for new tickets.

## Ticket header

Every ticket starts with these lines:

```
Status: <status>
Priority: P0 | P1 | P2
Owner: unassigned | claude | <agent name> | human
Blocked by: none | NN, NN
Created: YYYY-MM-DD
Updated: YYYY-MM-DD
```

## Statuses

| Status | Meaning | Next |
| --- | --- | --- |
| `needs-triage` | Captured, not yet planned | Write `## Plan` → `plan-review` |
| `needs-info` | Blocked on an answer from the user | Answer lands in `## Comments` → back to planning |
| `plan-review` | Plan written; the user reviews it | Approved → `ready-for-agent` or `ready-for-human`; changes requested → revise |
| `ready-for-agent` | Plan approved and the delegation brief is self-contained | Claim → `in-progress` |
| `ready-for-human` | Needs the user (credentials, manual testing, product calls) | — |
| `in-progress` | Claimed; `Owner` is set | `done`, `blocked`, or back to `plan-review` if the plan changes materially |
| `blocked` | Waiting on tickets in `Blocked by` or an external dependency | Unblocked → previous status |
| `done` | Acceptance criteria met; evidence recorded under `## Resolution` | — |
| `wontfix` | Dropped; reason recorded | — |

No ticket moves past `plan-review` without the user's approval of its plan.

## Operations

- **Create:** copy the template to `issues/NN-<slug>.md` (next free number), fill Context, Goal, Acceptance criteria, and Plan, set `plan-review` (or `needs-triage` if not planned yet), add a board row.
- **Claim:** set `Status: in-progress` and `Owner:` before starting work. One owner per ticket.
- **Delegate:** fill `## Delegation brief` so a cold agent can work from it alone: inputs, files to read first, constraints, acceptance checks, what to report back. Record the agent and run in `Owner` and a comment. Follow the sub-agent model rules in root `AGENTS.md`; GPT models run through the Codex CLI, Grok through the Cursor CLI.
- **Progress:** append dated entries under `## Comments` (newest last). Note decisions, evidence, and plan deviations there.
- **Resolve:** write `## Resolution` (what shipped, commits, proof, follow-up tickets), set `done`, update the board.
- **Split:** when a ticket grows, create follow-up tickets and link them in both directions.

## Done for the whole effort

The board has no open ticket, CI is green on the branch, the preview passes the browser critical-flow suite (ticket 06), and the user has finished their manual test pass.
