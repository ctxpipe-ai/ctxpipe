---
name: preview-env
description: >-
  preview-env critical-flow sweep of local host dev (https://app.ctxpipe.localhost)
  or an AWS PR preview (pr-N.ctxpipe.dev), or the AWS stack
  before its cutover (cutover.ctxpipe.dev), starting from a fresh
  registration. Use for the full browser + MCP suite, or one area: onboarding,
  auth, org-home, workspaces, hydrate, graph, chat, files-publish, connectors,
  mcp, resilience.
---

# preview-env

Browser + HTTP run of the **critical flows** against a **disposable** target: local host dev or an AWS PR preview. The product UI is driven through the backend origin; hosted MCP is `{BASE_URL}/mcp`. This is not the Storybook required plays and not Playwright CI. The agent drives the browser from this catalogue on every run; there are no recorded scripts to replay.

Every run **starts from registration**: it creates its own accounts, organization, and Workspaces. There are no pre-seeded users. Never point a run at production.

## AWS PR previews

An AWS preview of a pull request (`https://pr-<N>.ctxpipe.dev`) comes from the factory CLI, not from CI. No CI job builds a preview image.

1. Install the agent host once (`factory agent-host install`). It writes the AWS profile `ctxpipe-preview-push`.
2. Start Docker (Colima on a Mac).
3. In a ctxpipe checkout, run `factory preview up <N>` (`--repo <checkout>` from another folder).

The command starts the factory `preview.yml` run at once. The run makes the task group and the clone of the production database. At the same time, the command builds the images whose inputs changed since main's last deploy. Main's `scripts/ci/preview-images.mjs` decides which images changed. For the other images, the command copies main's images. It pushes all four to the preview account. The run waits for the images, then migrates and starts the services. Each output line has the time since the start. `factory preview down <N>` deletes the preview. Details: the factory CLI README, "Previews".

The PR page shows the preview as a GitHub Deployment in the environment `pr-preview`: "deployed to pr-preview", with a View deployment button that opens `https://pr-<N>.ctxpipe.dev`. No PR comment holds the link. When the preview goes (the PR closed, the preview expired 72 hours after its last `up`, or `factory preview down`), the deployment gets `inactive`. The link is always `https://pr-<N>.ctxpipe.dev`: a `success` deployment of the PR tells that the preview is there.

### Reach a preview with no person (temporary)

Cloudflare Access protects every path of `pr-<N>.ctxpipe.dev` except the webhook path. Until WARP runs on the agent host, an agent on the agent host passes Access with a service token that only the previews' Access app admits (factory [CTX-1416](https://linear.app/ctxpipe/issue/CTX-1416); approved by the CTO on 2026-11-20). Do not wait for a person's email code.

- Run each tool that calls the preview under `factory preview access -- <command> [args]`. The command gets the token in `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`, sends them as the headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and keeps its exit code. `factory` reads the token at each run; nothing stores it on the host.
- curl, with the headers from stdin so the secret is in no argument list:

  ```sh
  factory preview access -- sh -c 'printf "CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n" \
    "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" | curl -fsS -H @- https://pr-<N>.ctxpipe.dev/.status'
  ```

- Run only trusted code with the token: a script from a checkout of `main`, never from the tree of a PR. A PR can change the script, and then it can send the token to a different location. For example, from `apps/backend` of a `main` checkout: `factory preview access -- bun run src/scripts/validateTarget.ts https://pr-<N>.ctxpipe.dev --no-mcp-read`.
- A browser: never the headers. Do the steps of the [browser driver](harness.md#browser-driver), but write the response headers to a private temporary file (`-D "$(mktemp)"`), not to stdout.
- Never print the two variables or the `CF_Authorization` cookie, and never put them in a report, a log, a file in a repository, a commit or a PR.
- If `factory` says it cannot read the token, the AWS profiles of the host are older than this token: run `factory agent-host install <host>.pem` once, with the file that `factory agent-host issue` wrote for this host.
- The token opens only the previews: a production host refuses it. It lasts 30 days, and WARP on the agent host replaces it. Details: the factory CLI README, "Previews".

Only a pull request from ctxpipe-ai/ctxpipe itself into `main` gets a preview. `factory preview up` and the preview workflow refuse a PR from a fork. They refuse it before they build, push or clone anything. The [target guard](run-setup.md#target-guard) admits `https://pr-<N>.ctxpipe.dev` as the mode `preview`.

## 1. Collect inputs

| Input | Example |
| --- | --- |
| `BASE_URL` | `https://app.ctxpipe.localhost` or `https://pr-935.ctxpipe.dev` |
| `mode` | `local`, `preview` or `aws`, derived from `BASE_URL` in [run-setup](run-setup.md#target-guard) |
| `run-id` | UTC `YYYYMMDD-HHMMSS`, minted once per run |
| `GH_TEST_ORG` | `ctxpipe-ai` |
| `TEST_EMAIL_DOMAIN` | `agents.ctxpipe.dev` (the agents' inbox); see [run-setup](run-setup.md#test-inbox) |
| `local` only: trace export | the `local-<name>` environment from [run-setup](run-setup.md#local-trace-export) |

Optional: `section` (one or more area names); flags `live-oauth`, `merge-pr`, `default-branch-write`, `restart-ok` (each defined where it is used). Without a value for a required input, ask; do not invent one.

Run `local` before a preview of the same change.

**Done when:** every required input is a concrete string and the [target guard](run-setup.md#target-guard) passed.

## 2. Run setup and harness

Read [run-setup.md](run-setup.md) (accounts, test data, flow format, evidence, human checkpoints), then complete [harness.md](harness.md) (wake, sign-up page).

**Done when:** harness is `PASS`. A harness `FAIL` is a **blocker**: stop and report only the harness.

## 3. Choose areas

| Prompt | Areas |
| --- | --- |
| Full run / "run preview-env" / no `section` | all, in suite order |
| One or several named areas | those areas, still in suite order |

Suite order: `onboarding` → `auth` → `org-home` → `workspaces` → `hydrate` → `graph` → `chat` → `files-publish` → `connectors` → `mcp` → `resilience`.

`onboarding` creates the state every later area reads (accounts, org, first Workspace). A run that names a later area alone still runs `onboarding` first.

Load **only** the chosen area files; each lists its flows in the [fixed format](run-setup.md#flow-format):

- [onboarding](onboarding/SKILL.md)
- [auth](auth/SKILL.md)
- [org-home](org-home/SKILL.md)
- [workspaces](workspaces/SKILL.md)
- [hydrate](hydrate/SKILL.md)
- [graph](graph/SKILL.md)
- [chat](chat/SKILL.md)
- [files-publish](files-publish/SKILL.md)
- [connectors](connectors/SKILL.md)
- [mcp](mcp/SKILL.md)
- [resilience](resilience/SKILL.md)

A flow `FAIL` stops **that flow**; continue with the next flow unless it `Requires` the failed one (then `SKIP(blocked-by FLOW-ID)`). Stop the suite only for a harness-class blocker (session gone, worker or codesearch down while a later area needs it).

**Done when:** every flow in every chosen area has `PASS`, `FAIL`, or `SKIP(reason)`.

## 4. Report

Fill the template in [harness.md](harness.md#report): one row per flow with measured time against budget, evidence path, and trace.

**Done when:** the report lists every chosen flow and names the worst `FAIL` (or `all PASS`).

## 5. Clean up

Run [run-setup cleanup](run-setup.md#cleanup) after the report, also when the run stopped early.

**Done when:** `gh repo list {GH_TEST_ORG}` shows no `pe-{run-id}-*` repository.
