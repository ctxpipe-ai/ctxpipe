---
name: preview-env
description: >-
  preview-env critical-flow sweep of local host dev (https://app.ctxpipe.localhost)
  or a Railway PR preview (backend-pr-N.up.railway.app), starting from a fresh
  registration. Use for the full browser + MCP suite, or one area: onboarding,
  auth, org-home, workspaces, hydrate, graph, chat, files-publish, connectors,
  mcp, resilience.
---

# preview-env

Browser + HTTP run of the **critical flows** against a **disposable** target: local host dev or a Railway PR preview. The product UI is driven through the backend origin; hosted MCP is `{BASE_URL}/mcp?orgSlug={org}`. This is not Storybook `workspace-golden` and not Playwright CI. The agent drives the browser from this catalogue on every run; there are no recorded scripts to replay.

Every run **starts from registration**: it creates its own accounts, organization, and Workspaces. There are no pre-seeded users. Never point a run at production.

## 1. Collect inputs

| Input | Example |
| --- | --- |
| `BASE_URL` | `https://app.ctxpipe.localhost` or `https://backend-pr-280.up.railway.app` |
| `mode` | `local` or `preview`, derived from `BASE_URL` in [run-setup](run-setup.md#target-guard) |
| `run-id` | UTC `YYYYMMDD-HHMMSS`, minted once per run |
| `GH_TEST_ORG` | `ctxpipe-ai` |
| `TEST_EMAIL_DOMAIN` | `ctxpipe.dev` unless the prompt names another; see [run-setup](run-setup.md#test-data) |
| `local` only: trace export | the `local-<name>` environment from [run-setup](run-setup.md#local-trace-export) |

Optional: `section` (one or more area names); flags `live-oauth`, `merge-pr`, `default-branch-write`, `restart-ok` (each defined where it is used). Without a value for a required input, ask; do not invent one.

Run `local` before a preview of the same change.

**Done when:** every required input is a concrete string and the [target guard](run-setup.md#target-guard) passed.

## 2. Run setup and harness

Read [run-setup.md](run-setup.md) (accounts, test data, flow format, evidence, human checkpoints), then complete [harness.md](harness.md) (wake, canary).

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

A flow `FAIL` stops **that flow**; continue with the next flow unless it `Requires` the failed one (then `SKIP(blocked-by FLOW-ID)`). Stop the suite only for a harness-class blocker (session gone, production UI leak, worker never wakes while a later area needs it).

**Done when:** every flow in every chosen area has `PASS`, `FAIL`, or `SKIP(reason)`.

## 4. Report

Fill the template in [harness.md](harness.md#report): one row per flow with measured time against budget, evidence path, and trace.

**Done when:** the report lists every chosen flow and names the worst `FAIL` (or `all PASS`).

## 5. Clean up

Run [run-setup cleanup](run-setup.md#cleanup) after the report, also when the run stopped early.

**Done when:** `gh repo list {GH_TEST_ORG}` shows no `pe-{run-id}-*` repository.
