---
name: preview-env
description: >-
  preview-env sweep or debug of a Railway PR preview (backend-pr-N.up.railway.app).
  Use for a full UI+MCP suite, or one area: auth, org-home, workspaces, hydrate,
  chat, files-publish, graph, connectors, MCP.
---

# preview-env

Browser + HTTP sweep of a **hosted Railway PR preview** (`https://backend-pr-N.up.railway.app`). Product UI through the backend origin; hosted MCP at `{BASE_URL}/mcp?orgSlug={org}`. This is not Storybook `workspace-golden` and not Playwright CI.

## 1. Collect inputs

Required unless already in the prompt:

| Input | Example |
| --- | --- |
| `BASE_URL` | `https://backend-pr-280.up.railway.app` |
| email | session that can sign in on this preview |
| password | same |
| `orgSlug` | org the account is a member of |

Optional: `workspaceSlug` (else first `writeStatus === writable` workspace after login); `section` (one area name); `run-id` (else UTC `YYYYMMDD-HHMMSS`); flags `live-oauth`, `create-workspace`, `default-branch-write`.

Mint `run-id` once per sweep. **Done when:** every required input is a concrete string.

## 2. Run the harness

Read and complete every step in [harness.md](harness.md).

**Done when:** harness is `PASS` (status ok, UI is this preview, session on `{BASE_URL}/{orgSlug}/` or a workspace URL). A harness `FAIL` is a **blocker** — stop the sweep and report only harness.

## 3. Choose areas

| Prompt | Areas |
| --- | --- |
| Full sweep / “run preview-env” / no `section` | all, in order |
| One named area (“debug chat”, “run preview-env hydrate”, `section=mcp`) | that area only |
| Several named areas | those areas, still in suite order |

Suite order: `auth` → `org-home` → `workspaces` → `hydrate` → `graph` → `chat` → `files-publish` → `connectors` → `mcp`.

Load **only** the matching file; the steps live there:

- [auth](auth/SKILL.md)
- [org-home](org-home/SKILL.md)
- [workspaces](workspaces/SKILL.md)
- [hydrate](hydrate/SKILL.md)
- [graph](graph/SKILL.md)
- [chat](chat/SKILL.md)
- [files-publish](files-publish/SKILL.md)
- [connectors](connectors/SKILL.md)
- [mcp](mcp/SKILL.md)

An area `FAIL` stops **that** area. Continue the suite unless the failure is a harness-class blocker (session gone, production UI leak, worker never wakes when the next area needs it).

**Done when:** every chosen area file has been executed and has a `PASS` / `FAIL` / `SKIP`.

## 4. Report

Use the template in [harness.md](harness.md#report). One line per area: status, one-line evidence, artifact path if any.

**Done when:** the report lists every chosen area and names the worst `FAIL` (or `all PASS`).
