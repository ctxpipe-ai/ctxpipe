# preview-env run setup

Shared by every [preview-env](SKILL.md) run and every area. Complete it before the [harness](harness.md). Leading word: **run state**, the accounts, org, Workspaces, and ids this run creates and later flows read.

## Target guard

`BASE_URL` must be one of:

| Mode | Host pattern | Notes |
| --- | --- | --- |
| `local` | `https://app.ctxpipe.localhost` or `https://<branch>.app.ctxpipe.localhost` (linked worktree) | `pnpm dev` per the root AGENTS.md runbook; Docker infra up; migrations applied |
| `preview` | `https://backend-pr-<N>.up.railway.app` | Railway PR environment `pr-<N>`; its database is a **copy of production** |

Any other host, including `app.ctxpipe.ai`, is a **harness FAIL**: stop before opening a browser. A raw UI host or port misses the session cookie; always drive the backend origin.

## Test data

Mint `run-id` once (`YYYYMMDD-HHMMSS`, UTC). Everything the run creates carries it.

| Item | Value |
| --- | --- |
| Account A (admin, creates the org) | `preview-env+{run-id}-a@{TEST_EMAIL_DOMAIN}` |
| Account B (invitee, joins A's org) | `preview-env+{run-id}-b@{TEST_EMAIL_DOMAIN}` |
| Account C (outsider; wrong-account and cross-tenant checks) | `preview-env+{run-id}-c@{TEST_EMAIL_DOMAIN}` |
| Password | generated per account (24 random characters), kept in run state only, never printed in the report |
| Org | name `preview-env {run-id}`, slug `pe-{YYYYMMDDHHMMSS}` (17 characters; the limit is 32) |
| Browser sessions | one isolated browser context per account (A, B, C never share cookies) |

Use only addresses on `TEST_EMAIL_DOMAIN`; invitation mail may really send on a preview. If the domain rejects `+` tags, use `pe-{run-id}-{a|b|c}@{TEST_EMAIL_DOMAIN}`. Email sign-up needs no verification today (`emailAndPassword` without `requireEmailVerification`); if the sign-up screen waits for a verification link, the run needs a test inbox: record that as `SKIP(needs-inbox)`.

### GitHub test org and repositories

`GH_TEST_ORG` is a dedicated GitHub organization with the ctx| GitHub App installed on **all repositories**, so repositories created during the run are readable without another install step. It holds two persistent **template** repositories:

| Template | Content |
| --- | --- |
| `preview-env-seed-knowledge` | `AGENTS.md` with a `name`, 3-5 knowledge files with relative links and `claims:`, one file with malformed front matter |
| `preview-env-seed-code` | a small TypeScript repo with a README and one named function whose behavior has a known answer |

Per run, create copies (`gh repo create {GH_TEST_ORG}/preview-env-{run-id}-<suffix> --template …`, or the human uses **Create on GitHub**):

| Repo | Used as |
| --- | --- |
| `preview-env-{run-id}-ws` | workspace repository of Workspace 1 (from the knowledge template) |
| `preview-env-{run-id}-ws2` | workspace repository of Workspace 2 |
| `preview-env-{run-id}-code` | linked repository (from the code template); also the merged-PR mirror source |

Never push to the template repositories. Delete the per-run repositories after the report is filed.

### Connector test workspaces

Each provider needs its own test account. They are `ready-for-human` placeholders until the user supplies them; their flows `SKIP(needs-human)` meanwhile.

| Placeholder | Needs |
| --- | --- |
| `LINEAR_TEST` | Linear workspace with one team, a few issues |
| `NOTION_TEST` | Notion workspace with one page or database shared with the ctx| integration |
| `SLACK_TEST` | Slack workspace, one channel, the ctx| app installable |
| `CONFLUENCE_TEST` | Confluence site with one space and the Forge app installable |
| `PAGERDUTY_TEST` | PagerDuty account with one service and one incident |

### Run state

Keep one record and fill it as flows complete: `accountA/B/C`, `orgSlug`, `workspace1Slug`, `workspace2Slug`, `conversationIds[]`, repo names, `GH App connection id`. A flow that reads state a failed flow should have produced is `SKIP(blocked-by FLOW-ID)`.

## Flow format

Every flow in every area file has exactly these fields:

```markdown
### {AREA}-{n} {name}
**Requires** data, earlier flows, tickets, flags. Unmet: `SKIP(reason)`.
**Steps** numbered; click visible labels.
**Expect (UI)** what is visible; each item checkable.
**Expect (backend)** the DB row, git commit, or workflow run that must exist.
**Budget** target / fail, from which action to which visible state.
**Evidence** screenshot and recording names, trace.
```

Status of a flow:

- `PASS` every Expect met and time at or under the fail budget (note `SLOW` between target and fail).
- `FAIL` an Expect unmet, or time over the fail budget.
- `SKIP(reason)` with one of `needs-human`, `needs-ticket-NN`, `blocked-by FLOW-ID`, `hosted-only`, `preview-only`, `gated-<flag>`, `no-fixture`, `needs-inbox`.

Budgets are proposals until the user approves the catalogue.

### Human checkpoints

OAuth installs and provider consent screens (GitHub App install, Linear, Notion, Slack, Confluence, PagerDuty) are **human checkpoints**. At one, print the exact action and URL, then wait for the human to reply "done". A completed checkpoint counts toward `PASS` with the note `human`. With no human present the flow is `SKIP(needs-human)`; do not guess credentials.

## Timing

Start the clock at the triggering action (click, send, navigation) and stop it when the Expect (UI) state is first visible. Poll every 250 ms for budgets under 5 s, every second otherwise. Record milliseconds. Between target and fail the flow passes with `SLOW`.

## Evidence and traces

- Artifacts go to `/tmp/preview-env/{run-id}/` (not the repository): screenshots `{FLOW-ID}-{step}.png`, one recording per area `{area}.webm` of the working path only.
- **Trace** per flow: after the flow, find the trace for its key request with [observability](../observability/SKILL.md): environment `pr-<N>`, `ctxpipe.org.slug={orgSlug}`, the flow's time window, then the `TraceId`. For a curl step, take `x-request-id` from the response (`curl -D -`) and search by `request.id`. Record `trace: {TraceId} (env, org, HH:MM:SSZ)` plus the HyperDX link. For a job, record `openworkflow.run.id`.
- `local` mode exports no OTLP by default. Evidence is then the `x-request-id` plus the backend log line, unless the run exports to the shared collector with `RAILWAY_ENVIRONMENT_NAME=local-<name>`.
- Redact tokens, passwords, and emails in anything pasted outside `/tmp`.

## Verify backend side effects

| Side effect | `local` | `preview` |
| --- | --- | --- |
| Database row | read-only `SELECT` against `DATABASE_URL` in `apps/backend/.env.local` | Neon MCP (read-only) |
| Git commit or PR | `gh api repos/{GH_TEST_ORG}/{repo}/commits`, `gh pr view` | same |
| Workflow run | backend log line or `openworkflow` spans | HyperDX `SpanName = workflow_run.execute`, `openworkflow.run.id` |
| Sandbox | `workspace_sandbox_instances` row; Docker container | same row plus the Vercel sandbox tagged with the environment |

Tables the flows name: `users`, `sessions`, `accounts`, `organizations`, `members`, `invitations`, `apikeys`, `org_onboarding`, `connections`, `workspaces`, `workspace_linked_repositories`, `workspace_knowledge_units`, `workspace_write_jobs`, `workspace_repository_commits`, `workspace_commit_projections`, `conversations`, `conversation_messages`, `chat_threads`, `chat_runs`, `workspace_sandbox_instances`, `workspace_sandbox_git_tokens`. Run `\d <table>` before asserting a column; assert on presence, count, and state, not on exact schema.

## Write policy

- Write only to objects this run created: its org, its Workspaces, and `preview-env-{run-id}-*` repositories. Never write to a template repository.
- PR titles start with `[preview-env]`. Merge a PR only with flag `merge-pr` and only in a run-created repository.
- Provider OAuth through to a config PR needs flag `live-oauth`, a named provider, and a human checkpoint.
- Invite only `TEST_EMAIL_DOMAIN` addresses.
- On a preview the database is a production copy: read only rows this run created; never open or quote another org's data.
- Delete a Workspace only if this run created it and the flow says so.
