# preview-env harness

Shared setup for every [preview-env](SKILL.md) run. Complete this before any area skill. Leading word: **harness**.

## Inputs already collected

`BASE_URL`, email, password, `orgSlug`, optional `workspaceSlug`, `run-id`, gated flags. Drive the **backend origin** (`BASE_URL`). The UI is proxied there; a raw UI host will miss the session cookie.

## 1. Wake

```bash
curl -fsS "$BASE_URL/.status"
```

Body must be JSON with `status` equal to `"ok"`.

If the run includes `hydrate`, `graph`, `chat`, or `files-publish`, wake **worker** and **codesearch** on this `pr-N` environment (Railway MCP: service status, then `redeploy` / `restart-service` when `SLEEPING`). Proof is a **new deploy timestamp**, not a SUCCESS badge. Preview workers idle-exit (~180s); waiting does not keep them warm.

**Done when:** `/.status` is ok, and (if those areas run) worker and codesearch have a deploy timestamp newer than the wake call *or* are already `RUNNING` with a recent timestamp.

## 2. UI canary

Fetch the HTML at `BASE_URL/`, extract the proxied `/assets/main-*.js` filename, then:

1. Compare that hash to `https://app.ctxpipe.ai`’s `/assets/main-*.js`. **Same hash → harness FAIL** (production UI leak). Pin `UI_PROXY_URL` to `ui-pr-N`; do not continue.
2. `grep -Fq 'ws/$workspaceSlug'` the **JS bundle** (single-quoted, `set -u`). Missing canary → harness FAIL. Do not grep `/` HTML — TanStack SSR of `/` omits unmatched routes.

**Done when:** the preview’s main JS hash differs from production and the bundle contains `ws/$workspaceSlug`.

## 3. Sign in

One `computerUse` task:

1. Open `{BASE_URL}/.auth/sign-in`.
2. Submit email and password (Better Auth email/password fields).
3. Land on `{BASE_URL}/{orgSlug}/` or `{BASE_URL}/{orgSlug}/ws/…`. An error banner or staying on sign-in is FAIL.
4. If the URL is `/onboarding` or `/{orgSlug}/setup`, record that for [org-home](org-home/SKILL.md); the session is still valid.

**Done when:** the address bar is under `{BASE_URL}/{orgSlug}` (or onboarding/setup after a valid session) and SideNav or onboarding chrome is visible.

## computerUse

- One `computerUse` task per **area** after this harness login (reuse the signed-in browser).
- Click visible labels: `Home`, `Connectors`, `Files`, `Graph`, `Settings`, `Commit+Push`, `Create PR`, `Show PR`, `Try again`.
- Record only the area’s working path (walkthrough-artifacts). Split recordings if setup sits between areas.
- Prefer the same viewport; desktop is enough unless the prompt names mobile.

## Write policy

PR Neon is a **copy of production**. Default allow-list:

| Action | When |
| --- | --- |
| Read any org surface | always |
| Conversation file under `ctxpipe-preview-sweep/{run-id}/` + Commit+Push + Create PR | full sweep, or `files-publish` / `chat` as the named section |
| Create workspace | flag `create-workspace` and GitHub install is live |
| Workspace Files default-branch save | flag `default-branch-write` |
| Connector OAuth through to GitHub config PR | flag `live-oauth` and the user named the provider |

Stay on the designated `workspaceSlug`, or the first workspace whose detail has `writeStatus` equal to `"writable"`. PR title prefix `[preview-env]`. Leave the PR open (do not merge).

Delete workspace, disconnect GitHub, finish Slack/Linear/Notion/Confluence OAuth, submit **Install via PR** — only when the user names that action in this turn.

## Area failure

Stop that area. Attach Railway logs via [analyze-logs](../analyze-logs/SKILL.md) (Railway MCP first). For a chat hang, filter `step` in `opencode.chatStream` / `tanstack-workspace-chat`. Redact tokens and emails.

Harness-class blockers (do not continue the suite): sign-in failed, production UI leak, worker/codesearch never woke when a later area needs them.

## Report

```markdown
## preview-env report
origin: {BASE_URL}
org: {orgSlug}
workspace: {slug or "none"}
run-id: {run-id}

| Area | Status | Evidence |
| --- | --- | --- |
| harness | PASS/FAIL | /.status ok; main JS {hash} ≠ production; signed in |
| auth | … | … |

Worst: {area} FAIL — {one line} | all PASS
```

Status is `PASS`, `FAIL`, or `SKIP` (gated or missing fixture). Evidence is one checkable fact (URL, visible label, JSON field).
