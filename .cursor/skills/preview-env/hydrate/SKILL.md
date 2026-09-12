---
name: preview-env-hydrate
description: Workspace hydrate status, retry-prepare, and linked-repo index on a Railway PR preview.
disable-model-invocation: true
---

# preview-env hydrate

Workspace **revision** prepare (`workspace-hydrate` → projection + graph + `workspace-index`). Not `POST /repositories`. [Harness](../harness.md) is already `PASS`; worker and codesearch were woken. One `computerUse` plus curl.

Need a `workspaceSlug` from [workspaces](../workspaces/SKILL.md) or the prompt.

## 1. Read status

```bash
curl -fsS -b "$COOKIE_JAR" \
  "$BASE_URL/$orgSlug/api/v1/workspaces/$workspaceSlug"
```

Use the signed-in cookie (export from the browser or `/.auth/api/v1/auth/get-session` after login). Record `hydrateStatus`, `hydrateError`, `desiredSha`, `activeProjectionSha` / `indexedSha`.

On Settings, the hydrate chip matches: **Hydrate ready** / **Hydrating** / **Hydrate pending** / **Hydrate failed**.

**Done when:** JSON `hydrateStatus` is a string and the chip matches it.

## 2. Recover or trigger

| `hydrateStatus` | Action |
| --- | --- |
| `ready` and SHAs aligned | go to step 3 |
| `failed` | click **Try again** (`POST …/retry-prepare`) |
| `pending` / `running` | wait; poll the GET every 5s |
| `ready` but SHA lag | wait; same poll |

If still not ready and the user allowed writes: **Try again**, or (full sweep / `create-workspace`) create a workspace so bootstrap enqueues hydrate. A tiny default-branch write is only with `default-branch-write`.

Poll until `hydrateStatus` is `ready` **or** 3 minutes elapse. If the worker deploy timestamp did not move after enqueue, wake again (harness wake rule) and continue polling.

**Done when:** `hydrateStatus === "ready"` **or** this area is FAIL with Railway worker/codesearch logs attached.

## 3. Published tree

```bash
curl -sS -o /tmp/preview-env-tree.json -w "%{http_code}" -b "$COOKIE_JAR" \
  "$BASE_URL/$orgSlug/api/v1/workspaces/$workspaceSlug/files/tree"
```

**Done when:** HTTP is 200 (not 409). Open **Files** — a tree or empty-tree chrome, not a hydrate-progress blocker.

## 4. Linked-repo chips

On Settings, each linked repo is **Indexed**, or still **Indexing** / **Pending** with a note that codesearch is the blocker (SLEEPING / new deploy). Do not unlink.

**Done when:** every linked row has a chip, or the list is empty.

## Status

- **PASS** — `hydrateStatus === "ready"`, files/tree is 200, graph is not blocked by hydrate (graph area still runs its own checks).
- **FAIL** — still `failed` after retry, 409 tree after ready, or worker never ran (attach analyze-logs).
- **SKIP** — no workspace in the org (record; later areas that need a workspace FAIL).
