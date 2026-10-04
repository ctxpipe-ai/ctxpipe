# preview-env harness

Shared preflight for every [preview-env](SKILL.md) run. Complete [run-setup](run-setup.md) first, then this, before any area. Leading word: **harness**.

There is no sign-in step here: the run has no pre-seeded account. Registration is flow [ONB-1](onboarding/SKILL.md).

## 1. Wake

```bash
curl -fsS "$BASE_URL/.status"
```

Body must be JSON with `status` equal to `"ok"`.

`preview` only: if the run includes `hydrate`, `graph`, `chat`, `files-publish`, `connectors`, or `resilience`, wake **worker** and **codesearch** on this `pr-N` environment (Railway MCP: service status, then `redeploy` / `restart-service` when `SLEEPING`). Proof is a **new deploy timestamp**, not a SUCCESS badge. Preview workers idle-exit (~180 s); waiting does not keep them warm.

`local` only: Docker infra and codesearch are up (`pnpm dev:infra`, `pnpm dev`); a missing codesearch container is a harness FAIL for the areas above. Trace export is on ([local trace export](run-setup.md#local-trace-export)): send `curl -fsS -H "x-request-id: pe-{run-id}-wake" "$BASE_URL/.status"`, then find `SpanAttributes['request.id'] = 'pe-{run-id}-wake'` in HyperDX under `local-<name>` within a minute. No span is a harness FAIL.

**Done when:** `/.status` is ok, and (if those areas run) worker and codesearch have a deploy timestamp newer than the wake call or are already `RUNNING` with a recent timestamp (`preview`), or the local stack answers and its wake request is in HyperDX (`local`).

## 2. UI canary

`preview` only. Fetch the HTML at `BASE_URL/`, extract the proxied `/assets/main-*.js` filename, then:

1. Compare that hash to `https://app.ctxpipe.ai`'s `/assets/main-*.js`. **Same hash is a harness FAIL** (production UI leak). Pin `UI_PROXY_URL` to `ui-pr-N`; do not continue.
2. `grep -Fq 'ws/$workspaceSlug'` the **JS bundle** (single-quoted, `set -u`). Missing canary is a harness FAIL. Do not grep `/` HTML: TanStack SSR of `/` omits unmatched routes.

`local` runs the Vite dev server: skip the hash compare and check only that `https://app.ctxpipe.localhost/.auth/sign-up` renders from this origin.

**Done when:** on `preview`, the main JS hash differs from production and the bundle contains `ws/$workspaceSlug`; on `local`, the sign-up page rendered from the local origin.

## 3. Sign-up page

Open `{BASE_URL}/.auth/sign-up` in a fresh browser context. The form (email, password, submit) is visible and the session is signed out.

**Done when:** the form is on screen and `GET /.auth/api/v1/auth/get-session` returns no user.

## Browser driver

Any driver works (Cursor computer use, T3 Code preview tools, Playwright, another browser MCP). Name no tool in an area file; say what to click.

- One browser task per **area**, reusing that area's signed-in context. Account A, B, and C each get their own context.
- Click visible labels: `Home`, `Connectors`, `Files`, `Graph`, `Settings`, `Create PR`, `Show PR`, `Try again`, and the sidebar **+** (`aria-label` "Add Workspace").
- Record only the area's working path. Split recordings if setup sits between flows.
- Use one desktop viewport unless the prompt names mobile.

## Flow failure

Stop that flow. Attach the trace and logs via [observability](../observability/SKILL.md) (Railway MCP first on a preview whose process never exported). For a chat hang, filter `step` in `opencode.chatStream` / `tanstack-workspace-chat`. Redact tokens and emails.

Harness-class blockers (do not continue the suite): session gone mid-run with no way back, production UI leak, worker or codesearch never woke while a later area needs it.

## Report

```markdown
## preview-env report
origin: {BASE_URL}  mode: {local|preview}
run-id: {run-id}
org: {orgSlug}  workspaces: {slug1}, {slug2}
git: {commit sha of the checkout or preview deploy}
catalogue approved: {date, by role}

| Flow | Status | Measured / budget | Evidence | Trace |
| --- | --- | --- | --- | --- |
| harness | PASS/FAIL | - | /.status ok; hash differs; sign-up page | - |
| ONB-1 | PASS | 1.8 s / 3 s | /tmp/preview-env/{run-id}/ONB-1-2.png | {TraceId} (env, org, HH:MM:SSZ) |
| ONB-3 | SKIP(needs-human) | - | - | - |

Worst: {FLOW-ID} FAIL - {one line} | all PASS
SLOW: {FLOW-ID list between target and fail}
Skipped: {FLOW-ID list with reasons}
Follow-ups: {fix with regression test | ticket link per FAIL}
```

Status is `PASS`, `FAIL`, or `SKIP(reason)` as defined in [run-setup](run-setup.md#flow-format). Evidence is a path or one checkable fact (URL, visible label, JSON field). Every `FAIL` row carries its trace and a follow-up.
