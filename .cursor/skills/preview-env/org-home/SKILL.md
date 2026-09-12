---
name: preview-env-org-home
description: SideNav, Home composer, command palette, and org settings on a Railway PR preview.
disable-model-invocation: true
---

# preview-env org-home

Shell and Home. [Harness](../harness.md) is already `PASS`. One `computerUse` task.

## 1. SideNav

On `/{orgSlug}/` or a workspace, the rail shows **Home**, Search (⌘K control), **Connectors**, a Workspaces list, an org switcher, and an account control.

**Done when:** each of those five regions is visible (expanded nav if the rail is collapsed).

## 2. Home

Open **Home** (`/{orgSlug}/`). Either:

- a workspace picker + composer, and a **Recent** / activity region, or
- empty copy offering **Create a workspace**.

**Done when:** the path is `/{orgSlug}/` (no extra segment) and one of those two bodies is visible.

## 3. Command palette

Press ⌘K (Ctrl+K). The palette lists **Home**, **Connectors**, and at least one workspace if the org has any. Choose **Connectors**, then ⌘K again and choose **Home**.

**Done when:** URL becomes `/{orgSlug}/connectors` then returns to `/{orgSlug}/`.

## 4. Org settings

Open `/{orgSlug}/organization/settings` (org menu). Members/invites chrome is visible. View only.

**Done when:** the path contains `/organization/` and the settings view rendered.

## 5. Onboarding (only if redirected)

If login landed on `/onboarding` or `/{orgSlug}/setup`, walk the slides. Leave GitHub, **Install via PR**, and invite incomplete.

**Done when:** every slide in that carousel was shown, or this step is N/A.

## Status

- **PASS** — steps 1–4 (and 5 if it applied) met their criteria.
- **FAIL** — missing SideNav region, Home blank/error, palette does not navigate, org settings error.
