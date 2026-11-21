# preview-env harness

Shared preflight for every [preview-env](SKILL.md) run. Complete [run-setup](run-setup.md) first, then this, before any area. Leading word: **harness**.

There is no sign-in step here: the run has no pre-seeded account. Registration is flow [ONB-1](onboarding/SKILL.md).

## 1. Wake

`local`:

```bash
curl -fsS "$BASE_URL/.status"
```

Body must be JSON with `status` equal to `"ok"`. Cloudflare Access protects `/.status` on `preview` and `aws`: there the `validateTarget` step below checks it.

`preview` only: from `apps/backend` of a `main` checkout, run `validateTarget` under `factory preview access`, as [reach a preview with no person](SKILL.md#reach-a-preview-with-no-person-temporary) shows (`--no-mcp-read`). It checks `/.status` too. A failed check is a harness FAIL. A 502 means that the preview is not up: run `factory preview up <N>`, then wake again. An AWS preview does not sleep: its worker and codesearch run until the preview goes.

`local` only: Docker infra and codesearch are up (`pnpm dev:infra`, `pnpm dev`); a missing codesearch container is a harness FAIL when the run includes `hydrate`, `graph`, `chat`, `files-publish`, `connectors`, or `resilience`. Trace export is on ([local trace export](run-setup.md#local-trace-export)): send `curl -fsS -H "x-request-id: pe-{run-id}-wake" "$BASE_URL/.status"`, then find `SpanAttributes['request.id'] = 'pe-{run-id}-wake'` in HyperDX under `local-<name>` within a minute. No span is a harness FAIL.

`aws` only: each request sends the Access service token (`-H "CF-Access-Client-Id: …" -H "CF-Access-Client-Secret: …"`), unless the agent host uses WARP. From `apps/backend`, run `bun run src/scripts/validateTarget.ts "$BASE_URL" --no-mcp-read` with `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` set. A failed check is a harness FAIL. Before the sweep, the database has no test org, so this step skips the `mcp read` check. The [mcp](mcp/SKILL.md) area tests MCP with the account of this run. In the cutover window, the runbook runs the script against `https://app.ctxpipe.ai` without `--no-mcp-read`, with `VALIDATE_API_KEY` set to a personal API key of a test org. Without that key, the `mcp read` check fails.

**Done when:** `/.status` is ok, and:

- `preview`: each `validateTarget` check passed.
- `local`: the local stack answers, and its wake request is in HyperDX.
- `aws`: each `validateTarget` check passed.

## 2. Sign-up page

Open `{BASE_URL}/.auth/sign-up` in a fresh browser context. The form (email, password, submit) is visible and the session is signed out.

**Done when:** the form is on screen and `GET /.auth/api/v1/auth/get-session` returns no user.

## Browser driver

Any driver works (Cursor computer use, T3 Code preview tools, Playwright, another browser MCP). Name no tool in an area file; say what to click.

- One browser task per **area**, reusing that area's signed-in context. Account A, B, and C each get their own context.
- Click visible labels: `Home`, `Connectors`, `Files`, `Graph`, `Settings`, `Create PR`, `Show PR`, `Try again`, and the sidebar **+** (`aria-label` "Add Workspace").
- Record only the area's working path. Split recordings if setup sits between flows.
- Use one desktop viewport unless the prompt names mobile.
- `preview` and `aws` without WARP: never add the Access service-token headers in the browser. A header that a route handler adds also goes to each redirect, for example to a provider OAuth page. Instead, send one request with the service token to `BASE_URL`, and write its response headers to a private temporary file, never to stdout. On `preview`:

  ```sh
  headers=$(mktemp)
  factory preview access -- sh -c 'printf "CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n" \
    "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" | curl -fsS -o /dev/null -D "$0" -H @- "$1/"' "$headers" "$BASE_URL"
  ```

  Add its `CF_Authorization` cookie to the context for the `BASE_URL` host only, then delete the file. If the response sets no such cookie, use WARP.

## Flow failure

Stop that flow. Attach the trace and logs via [observability](../observability/SKILL.md) (on a preview whose process never exported, its CloudWatch log groups `pr-<N>-*` in the preview account, through the factory's read-only audit role `factory-audit`; the preview holds customer data, so attach only the log group, the stream and the time, never the log text). For a chat hang, filter `step` in `opencode.chatStream` / `tanstack-workspace-chat`. Redact tokens and emails.

Harness-class blockers (do not continue the suite): session gone mid-run with no way back, worker or codesearch down while a later area needs it.

## Report

```markdown
## preview-env report
origin: {BASE_URL}  mode: {local|preview|aws}
run-id: {run-id}
org: {orgSlug}  workspaces: {slug1}, {slug2}
git: {commit sha of the checkout or preview deploy}
catalogue approved: {date, by role}

| Flow | Status | Measured / budget | Evidence | Trace |
| --- | --- | --- | --- | --- |
| harness | PASS/FAIL | - | /.status ok (validateTarget on `preview` and `aws`); sign-up page | - |
| ONB-1 | PASS | 1.8 s / 3 s | /tmp/preview-env/{run-id}/ONB-1-2.png | {TraceId} (env, org, HH:MM:SSZ) |
| ONB-3 | SKIP(needs-human) | - | - | - |

Worst: {FLOW-ID} FAIL - {one line} | all PASS
SLOW: {FLOW-ID list between target and fail}
Skipped: {FLOW-ID list with reasons}
Follow-ups: {fix with regression test | ticket link per FAIL}
```

Status is `PASS`, `FAIL`, or `SKIP(reason)` as defined in [run-setup](run-setup.md#flow-format). Evidence is a path or one checkable fact (URL, visible label, JSON field). Every `FAIL` row carries its trace and a follow-up.
