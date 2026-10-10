---
name: preview-env-org-home
description: SideNav, Home composer and activity, command palette, and org settings (preview-env).
disable-model-invocation: true
---

# preview-env org-home

Shell and Home for the run's org. [Harness](../harness.md) is `PASS`; [onboarding](../onboarding/SKILL.md) created the org and Workspace 1. Flow format: [run-setup](../run-setup.md#flow-format). Home is `/{orgSlug}/` (a page); sign-in lands on a Workspace composer, not Home.

### HOME-1 SideNav regions
**Requires** ONB-5.
**Steps**
1. On `/{orgSlug}/` or a Workspace, expand the rail if collapsed.

**Expect (UI)** visible: **Home**, **Search** (⌘K), **Connectors**, a **Workspaces** label with a **+** button (`aria-label` "Add Workspace") and Workspace rows, the organization switcher, and the account control. No org-wide **Chat**, **Repositories**, or **Knowledge graph** entries.
**Expect (backend)** none.
**Budget** 3 s / 10 s, navigation to rail visible.
**Evidence** `HOME-1-1.png`.

### HOME-2 Home dashboard
**Requires** ONB-5.
**Steps**
1. Open **Home** (`/{orgSlug}/`, no extra segment).

**Expect (UI)** a Workspace picker (`aria-label` "Select workspace") showing Workspace 1, the composer (placeholder **Ask about this Workspace…**), and the activity region (heatmap and recent commits, or **No commits on the default branch yet.**). In an org with no Workspace, the body is a **Create a workspace** button instead.
**Expect (backend)** `GET /{orgSlug}/api/v1/workspaces/{slug}/activity` returns 200.
**Budget** 3 s / 10 s, navigation to composer visible.
**Evidence** `HOME-2-1.png`; trace of the activity request.

### HOME-3 Send from Home opens a conversation
**Requires** HOME-2; hydrate need not be ready (the answer is timed in [CHAT-1](../chat/SKILL.md)).
**Steps**
1. On Home, pick Workspace 1, type a real question about its repository, and send.

**Expect (UI)** the URL becomes `/{orgSlug}/ws/{workspace1Slug}/conv_…` immediately; the user bubble is shown with **Setting up sandbox** or **Thinking…**; the sidebar lists the conversation as **New conversation**, then a model-written title after the first turn.
**Expect (backend)** `conversations` row (source `ui`) for the Workspace; `chat_threads` row; first message in `conversation_messages` after the turn.
**Budget** 1 s / 2 s, Send to the URL containing `conv_`.
**Evidence** `HOME-3-1.png`; the new conversation id; trace of the conversation-create request.

### HOME-4 Command palette
**Requires** HOME-1.
**Steps**
1. Press ⌘K (Ctrl+K). Choose **Connectors**.
2. Press ⌘K again and choose **Home**.

**Expect (UI)** the palette lists **Home**, **Connectors**, and Workspace 1; the URL goes to `/{orgSlug}/connectors` then back to `/{orgSlug}/`.
**Expect (backend)** none.
**Budget** 1 s / 3 s per navigation.
**Evidence** `HOME-4-1.png`.

### HOME-5 Org settings
**Requires** ONB-2.
**Steps**
1. Open `/{orgSlug}/organization/settings` from the organization menu.
2. Open **Members** and **API Keys** from the settings nav (`/organization/members`, `/organization/api-keys`).

**Expect (UI)** heading **organisation settings**; **Settings**, **Members**, **API Keys** tabs render. There is **no** Add Workspace entry here (Add Workspace is the sidebar **+**, decision 2026-10-02).
**Expect (backend)** none for viewing.
**Budget** 3 s / 10 s per view.
**Evidence** `HOME-5-1.png`.

## Status

- **PASS** HOME-1 to HOME-5 `PASS`.
- **FAIL** a missing SideNav region, Home blank or error, the palette not navigating, an org settings error, or an Add Workspace entry in org settings.
