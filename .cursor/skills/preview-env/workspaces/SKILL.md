---
name: preview-env-workspaces
description: Open, create, rename, link repositories to, and delete Workspaces; panes and settings chips (preview-env).
disable-model-invocation: true
---

# preview-env workspaces

Workspace identity and lifecycle. [Harness](../harness.md) is `PASS`; Workspace 1 exists from [ONB-5](../onboarding/SKILL.md). Flow format: [run-setup](../run-setup.md#flow-format). A Workspace has one workspace repository and zero or more linked repositories; a URL is the workspace repository of at most one Workspace per org.

### WS-1 Open and switch panes
**Requires** ONB-5.
**Steps**
1. Open `{BASE_URL}/{orgSlug}/ws/{workspace1Slug}`.
2. Click **Files**, **Graph**, **Settings**; then close the pane.
3. Open any conversation (see [CHAT-1](../chat/SKILL.md)) and click **Diff**.
4. Return to the bare Workspace URL.

**Expect (UI)** the bare URL shows the composer (always a new composer) and the Workspace name; each tab sets `pane=files`, `pane=graph`, `pane=settings`; **Diff** sets `pane=diff` on a conversation URL only; closing removes `pane`.
**Expect (backend)** opening the bare URL creates no `conversations` row.
**Budget** 3 s / 10 s to compose; 1 s / 3 s per pane switch.
**Evidence** `WS-1-1.png`; trace of the workspace detail request.

### WS-2 Read the settings chips
**Requires** WS-1.
**Steps**
1. Open **Settings**.

**Expect (UI)** write chip **Writable**, **Read-only**, or **Checking write access**; hydrate chip **Hydrate ready**, **Hydrating**, **Hydrate pending**, or **Hydrate failed**; display name and slug fields; the **Linked repositories** section (possibly empty). Record `writeStatus` and `hydrateStatus` for later flows.
**Expect (backend)** `GET /{orgSlug}/api/v1/workspaces/{slug}` returns the same `writeStatus` and `hydrateStatus`.
**Budget** 3 s / 10 s, **Settings** click to chips visible.
**Evidence** `WS-2-1.png`; JSON status fields.

### WS-3 Add Workspace from the sidebar +
**Requires** WS-1; repo `preview-env-{run-id}-ws2`.
**Steps**
1. Click the **+** next to the **Workspaces** label (`aria-label` "Add Workspace").
2. In the dialog, **Select GitHub**, search `preview-env-{run-id}-ws2`, select it, click **Create Workspace**.
3. With two Workspaces, click Workspace 2's title, then Workspace 1's title.

**Expect (UI)** the dialog opens; after create the URL is `/{orgSlug}/ws/{workspace2Slug}` and the sidebar shows two rows, both collapsible; a title click on a **different** Workspace opens its most recent conversation (or its composer when it has none); on the **current** Workspace it only toggles the conversation list.
**Expect (backend)** second `workspaces` row, slug unique in the org; `workspace-bootstrap` and `workspace-hydrate` runs for it.
**Budget** 3 s / 10 s, **Create Workspace** to composer.
**Evidence** `WS-3-1.png` (dialog), `WS-3-2.png` (two rows); trace of the create request.

### WS-4 Create variants: Create on GitHub and Paste URL
**Requires** WS-3 (any further repo); for **Create on GitHub** a human or `gh` creating `preview-env-{run-id}-v1` in `GH_TEST_ORG`; for **Paste URL** a public non-GitHub git URL (`SKIP(no-fixture)` if none) and `https://github.com/{GH_TEST_ORG}/preview-env-{run-id}-code.git`.
**Steps**
1. **+**, tab **Create on GitHub**: the link opens `https://github.com/new` in a new tab; create the repository, return, **Select GitHub**, select it.
2. **+**, tab **Paste URL**, paste the `-code` repo URL (a repository that already backs a Workspace in this org returns the existing row, which passes).
3. Paste the non-GitHub URL and create.

**Expect (UI)** each path creates (or returns) a Workspace; the non-GitHub Workspace shows **Read-only** with a reason and no publish actions.
**Expect (backend)** `workspaces` rows; for a writable repo a bootstrap commit; for the read-only one no commit and hydrate still runs.
**Budget** 3 s / 10 s per create.
**Evidence** `WS-4-1.png`, `WS-4-2.png`; traces.
Delete the extra Workspaces afterward through WS-7 so later areas see only Workspace 1 and 2.

### WS-5 Rename display name and slug
**Requires** WS-2; Workspace 2.
**Steps**
1. On Workspace 2's **Settings**, set **Display name** to `Preview Env {run-id}` and **Slug** to `pe-{run-id compact}-2`; **Save**.
2. Open the old slug URL.

**Expect (UI)** the URL is replaced with the new slug and the sidebar shows the new name; the old slug URL shows a not-found error inside the shell; a slug already used in the org is rejected inline.
**Expect (backend)** `workspaces.slug` updated, same `ws_*` id; a write job commits the new `name` in `AGENTS.md` on the default branch (one commit).
**Budget** 2 s / 5 s, **Save** to new URL; 60 s / 3 min, **Save** to the `AGENTS.md` commit.
**Evidence** `WS-5-1.png`; `gh api` commit; trace and `openworkflow.run.id` of the write job. *Uncertain:* the exact job name for a display-name edit.

### WS-6 Link and unlink a repository
**Requires** WS-2 `Writable`; Workspace 1 hydrate ready ([HYD-1](../hydrate/SKILL.md)); repo `preview-env-{run-id}-code`.
**Steps**
1. On Workspace 1's **Settings**, **Add repositories**, select `preview-env-{run-id}-code`, **Link**.
2. Watch the row's chip.
3. Click **Unlink** (`aria-label` "Unlink {repo}") and confirm.

**Expect (UI)** a row with chip **Pending** or **Indexing**, then **Indexed**; after unlink the row is gone.
**Expect (backend)** `workspace_linked_repositories` row; a `workspace-link-unlink` run that commits `repositories/{name}.md` to the workspace repository; a `repository-index` run until the code index completes; on unlink a commit removing that file and the row deleted. After ticket 12 (per-Workspace PR mirror) lands, link also triggers the merged-PR backfill ([CON-8](../connectors/SKILL.md)).
**Budget** 3 s / 10 s, **Link** to the row; 90 s / 5 min, **Link** to **Indexed**; 30 s / 2 min, **Unlink** to the removal commit.
**Evidence** `WS-6-1.png`, `WS-6-2.png`; `gh api` commits; trace and run ids.
Keep the repository linked when a later flow needs it (chat code questions, [CON-8](../connectors/SKILL.md)); unlink at the end of the run.

### WS-7 Delete a Workspace with confirmation
**Requires** WS-3 or WS-4 (a run-created Workspace other than Workspace 1).
**Steps**
1. On the Workspace's **Settings**, click **Delete Workspace**.
2. In **Delete Workspace?**, type the wrong name, then the correct name; confirm.

**Expect (UI)** the confirm button stays disabled until the typed name matches; afterward the browser leaves the Workspace URL for `/{orgSlug}`; the sidebar row is gone.
**Expect (backend)** `workspaces` row and its conversations removed; the git repository still exists (`gh api repos/...` returns 200); a following `GET` of the slug returns 404.
**Budget** 3 s / 10 s, confirm to redirect.
**Evidence** `WS-7-1.png`; trace of the delete request.
Deleting the last Workspace in an org sends `/` to `/{orgSlug}/workspaces/new` (the zero-Workspace gate); do not run that on the main org.

## Status

- **PASS** WS-1, WS-2, WS-3, WS-5, WS-6, WS-7 `PASS`; WS-4 `PASS` or `SKIP`.
- **FAIL** a Workspace 404 or access denied, panes not changing `?pane=`, chips missing, a duplicate slug accepted, or a Workspace row surviving delete.
