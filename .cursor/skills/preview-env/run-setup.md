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

`TEST_EMAIL_DOMAIN` defaults to `ctxpipe.dev`, a domain the team owns; a prompt may name another. Use only addresses on it. Invitation mail may really be delivered to that domain on a target with SMTP configured; the run still reads the invitation link the way [AUTH-5](auth/SKILL.md) says, not from the mailbox. If the domain rejects `+` tags, use `pe-{run-id}-{a|b|c}@{TEST_EMAIL_DOMAIN}`. Email sign-up needs no verification today (`emailAndPassword` without `requireEmailVerification`); if the sign-up screen waits for a verification link, the run needs a test inbox: record that as `SKIP(needs-inbox)`.

### GitHub test org and repositories

`GH_TEST_ORG` is `ctxpipe-ai`, with the ctx| GitHub App installed on **all repositories**, so repositories created during the run are readable without another install step. It is the team's own organization, so the run creates and deletes only throwaway repositories whose names start with `pe-{run-id}-`, and touches nothing else there. It holds two persistent **template** repositories:

| Template | Content |
| --- | --- |
| `preview-env-seed-knowledge` | `AGENTS.md` with a `name`, 3-5 knowledge files with relative links and `claims:`, one file with malformed front matter |
| `preview-env-seed-code` | a small TypeScript repo with a README and one named function whose behavior has a known answer |

Per run, create copies (`gh repo create {GH_TEST_ORG}/pe-{run-id}-<suffix> --template …`, or the human uses **Create on GitHub**):

| Repo | Used as |
| --- | --- |
| `pe-{run-id}-ws` | workspace repository of Workspace 1 (from the knowledge template) |
| `pe-{run-id}-ws2` | workspace repository of Workspace 2 |
| `pe-{run-id}-code` | linked repository (from the code template); also the merged-PR mirror source |

Never push to the template repositories. If a template is missing, ask before creating it: it outlives the run. `gh` needs a token that can create, merge in, and delete repositories in `GH_TEST_ORG`; keep it in the run's shell only.

### Cleanup

After the report, and also when a run stops early, delete every repository this run created:

```bash
for repo in $(gh repo list {GH_TEST_ORG} --limit 200 --json name \
  --jq '.[].name | select(startswith("pe-{run-id}-"))'); do
  gh repo delete "{GH_TEST_ORG}/$repo" --yes
done
```

Delete only names with this run's `pe-{run-id}-` prefix (the token needs the `delete_repo` scope). Record leftovers (a delete that failed) in the report's Follow-ups. The org, accounts, and Workspaces on the target stay; `local` data goes with the local database, a preview's with its environment.

### Connector test workspaces

Each provider needs its own test account. They are `ready-for-human` placeholders until the user supplies them; their flows `SKIP(needs-human)` meanwhile. On the first run every provider flow (Linear, Notion, Slack, Confluence, PagerDuty) is `SKIP(first-run)`; the GitHub merged-PR mirror ([CON-8](connectors/SKILL.md)) still runs.

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
- `SKIP(reason)` with one of `needs-human`, `needs-ticket-NN`, `blocked-by FLOW-ID`, `hosted-only`, `preview-only`, `gated-<flag>`, `no-fixture`, `needs-inbox`, `first-run`, `contract-test`.

Budgets are approved (user, 2026-10-04).

### Human checkpoints

OAuth installs and consent screens (GitHub App install, provider OAuth for Linear, Notion, Slack, Confluence, PagerDuty, and MCP OAuth client consent) are **human checkpoints**; the run does not automate them. At one, print the exact action and URL, then wait for the human to reply "done". A completed checkpoint counts toward `PASS` with the note `human`. With no human present the flow is `SKIP(needs-human)`; do not guess credentials.

## Timing

Start the clock at the triggering action (click, send, navigation) and stop it when the Expect (UI) state is first visible. Poll every 250 ms for budgets under 5 s, every second otherwise. Record milliseconds. Between target and fail the flow passes with `SLOW`.

## Evidence and traces

- Artifacts go to `/tmp/preview-env/{run-id}/` (not the repository): screenshots `{FLOW-ID}-{step}.png`, one recording per area `{area}.webm` of the working path only.
- **Trace** per flow, in both modes: after the flow, find the trace for its key request with [observability](../observability/SKILL.md): environment `pr-<N>` (`preview`) or `local-<name>` (`local`), `ctxpipe.org.slug={orgSlug}`, the flow's time window, then the `TraceId`. For a curl step, take `x-request-id` from the response (`curl -D -`) and search by `request.id`. Record `trace: {TraceId} (env, org, HH:MM:SSZ)` plus the HyperDX link. For a job, record `openworkflow.run.id`. A flow with no exported trace has incomplete evidence: say so in the row; a `FAIL` without a trace is a harness problem to fix before the next run.
- Redact tokens, passwords, and emails in anything pasted outside `/tmp`.

### Local trace export

A `local` run exports traces and logs to the hosted collector so every flow is debuggable in HyperDX. Before `pnpm dev`, `apps/backend/.env.local` (gitignored) must hold:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://telemetry.ctxpipe.ai/v1/traces
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://telemetry.ctxpipe.ai/v1/logs
OTEL_EXPORTER_OTLP_HEADERS=authorization=<HYPERDX_API_KEY>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=local-<name>
```

`<name>` is the person or agent running it (for example `local-preview-env`). `HYPERDX_API_KEY` is the collector's ingest token, not the personal `HYPERDX_ACCESS_KEY` the MCP uses; ask the human for it when it is not already in `.env.local`, and never print or commit it. `pnpm dev` passes these to the backend, the worker, the codesearch container, and the UI's `/.otel` relay ([USING.md](../../../ops/observability/USING.md#localhost-telemetry)). Restart `pnpm dev` after editing `.env.local`. The [harness](harness.md#1-wake) checks that export works.

## Verify backend side effects

| Side effect | `local` | `preview` |
| --- | --- | --- |
| Database row | read-only `SELECT` against `DATABASE_URL` in `apps/backend/.env.local` | Neon MCP (read-only) |
| Git commit or PR | `gh api repos/{GH_TEST_ORG}/{repo}/commits`, `gh pr view` | same |
| Workflow run | HyperDX `SpanName = workflow_run.execute` in `local-<name>`, `openworkflow.run.id` | HyperDX `SpanName = workflow_run.execute`, `openworkflow.run.id` |
| Sandbox | `workspace_sandbox_instances` row; Docker container | same row plus the Vercel sandbox tagged with the environment |

Tables the flows name: `users`, `sessions`, `accounts`, `organizations`, `members`, `invitations`, `apikeys`, `org_onboarding`, `connections`, `workspaces`, `workspace_linked_repositories`, `workspace_knowledge_units`, `workspace_write_jobs`, `workspace_repository_commits`, `workspace_commit_projections`, `conversations`, `conversation_messages`, `chat_threads`, `chat_runs`, `workspace_sandbox_instances`, `workspace_sandbox_git_tokens`. Run `\d <table>` before asserting a column; assert on presence, count, and state, not on exact schema.

## Write policy

- Write only to objects this run created: its org, its Workspaces, and `pe-{run-id}-*` repositories. Never write to a template repository.
- PR titles start with `[preview-env]`. Merge a PR only with flag `merge-pr` and only in a run-created repository.
- Provider OAuth through to a config PR needs flag `live-oauth`, a named provider, and a human checkpoint.
- Restarting or redeploying target services (flag `restart-ok`) is allowed on `local` and on the `pr-280` preview only; on any other preview the flows that need it are `SKIP(gated-restart-ok)`. Waking a `SLEEPING` service in the [harness](harness.md#1-wake) is not a restart.
- Invite only `TEST_EMAIL_DOMAIN` addresses.
- On a preview the database is a production copy: read only rows this run created; never open or quote another org's data.
- Delete a Workspace only if this run created it and the flow says so.
