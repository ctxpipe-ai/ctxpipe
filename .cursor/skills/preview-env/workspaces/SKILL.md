---
name: preview-env-workspaces
description: Open a workspace, switch panes, and read settings chips on a Railway PR preview.
disable-model-invocation: true
---

# preview-env workspaces

Workspace identity. [Harness](../harness.md) is already `PASS`. One `computerUse` task. Resolve `workspaceSlug` now if the prompt omitted it: first SideNav workspace, confirmed writable via settings chips or `GET /{orgSlug}/api/v1/workspaces/{slug}`.

## 1. Open

Navigate to `{BASE_URL}/{orgSlug}/ws/{workspaceSlug}`. Compose (empty chat) or a conversation layout mounts; the workspace name is in chrome.

**Done when:** the path is `/{orgSlug}/ws/{workspaceSlug}` or `…/{conversationId}`, and the workspace title is visible.

## 2. Panes

Open each tool tab so the query updates:

| Tab | URL contains |
| --- | --- |
| **Files** | `pane=files` |
| **Graph** | `pane=graph` |
| **Settings** | `pane=settings` |

**Diff** exists only on a conversation URL (`pane=diff`). Open it if a conversation is already selected; otherwise SKIP Diff.

**Done when:** the address bar showed each of those `pane=` values in turn.

## 3. Settings chips

On **Settings**: write chip is **Writable**, **Read-only**, or **Checking write access**; hydrate chip is **Hydrate ready**, **Hydrating**, **Hydrate pending**, or **Hydrate failed**. Linked repositories list is present (possibly empty). Index chips on linked rows are **Indexed**, **Indexing**, or **Pending**.

Record `writeStatus` / `hydrateStatus` for later areas. Do not relink or delete.

**Done when:** both chips are readable and the linked-repo section rendered.

## 4. Create (gated)

Only with flag `create-workspace` and a live GitHub install: `{BASE_URL}/{orgSlug}/workspaces/new`, pick a repo this org already can access. If that git URL already backs a workspace, the product returns the existing row — that is PASS.

**Done when:** this step is SKIP, or the URL is `/{orgSlug}/ws/{someSlug}` after submit.

## Status

- **PASS** — steps 1–3 met; step 4 SKIP or met.
- **SKIP** create/relink/delete unless the user named them.
- **FAIL** — workspace 404/access denied, panes do not change `?pane=`, settings chips missing.
