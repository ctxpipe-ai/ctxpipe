# Show knowledge files skipped as malformed on the Workspace page

Status: done (pending review and merge into PR 280)
Priority: P2
Owner: implementation sub-agent
Blocked by: none
Created: 2026-10-04
Updated: 2026-10-05

## Context

Hydrate (`apps/backend/src/domain/workspaces/hydrate.ts`) skips a knowledge file whose front matter it cannot parse, and a linked-repository declaration that is unparsable or repeats a repository, and records `{ path, reason: "malformed" }` in `skipped`. The `workspace-hydrate` workflow returns that list as `diagnostics` in its run result (`openworkflow/workflows/workspace-hydrate.ts`), and nothing else keeps it. The Workspace still reaches **Hydrate ready**, so a user whose file vanished from chat, MCP, and the graph has no way to see why: the file is in **Files** (it is in git) but not in the projection.

Found while writing the browser critical-flow catalogue (ticket 06, flow HYD-2). User decision (2026-10-04): create this ticket.

## Goal

A Workspace member can see which knowledge files the current projection skipped, and why, from the Workspace page.

## Acceptance criteria

- [ ] The skipped list of the active projection (path and reason) is persisted with the revision and returned by the Workspace API.
- [ ] The Workspace page shows a notice when the list is not empty, naming each file (a link to it in **Files**) and the reason in plain words; nothing is shown when it is empty.
- [ ] A new hydrate of a fixed file clears the notice.
- [ ] Storybook play for the notice (MSW) and a backend test with a real database for the persisted list.
- [ ] Public docs (`apps/docs/content/docs/(guide)/workspaces/`) say what a skipped file is and how to fix it.
- [ ] preview-env HYD-2 expects the notice instead of recording "no UI surface".

## Plan

1. Triage: confirm priority and whether it ships in PR 280.
2. Decide where the notice lives (Settings hydrate chip, **Files** tree badge, or both) with the product-ui skill.
3. Persist, expose, render; tests as above.

## Open questions

- `HydrateSkip` also allows `not_knowledge`, which nothing emits today: drop it, or show it once it is used?
- Settings chip, **Files** badge, or both?

## Delegation brief

Read `domain/workspaces/hydrate.ts`, `openworkflow/workflows/workspace-hydrate.ts`, the Workspace status API and its UI consumer (Settings hydrate chip), `.ai/memory/PRDs/workspaces.md`, and `.cursor/skills/product-ui/`. Keep the change to one persisted field plus one UI notice.

## Comments

### 2026-10-05 — implementation landed

Decisions applied: ship in PR 280 at P2; one persisted field and one notice in **Settings**, below the hydrate chips; no **Files** tree badge.

What changed:

- `HydrateSkip.reason` is `malformed` or `duplicate_repository`. The unused `not_knowledge` is gone. A linked-repository file that repeats a repository now reports `duplicate_repository`, not `malformed`, so the UI can name the cause.
- New column `workspaces.active_projection_skipped` (`jsonb not null default '[]'`, migration `20261004205039_workspace-active-projection-skipped`). `commitHydrateProjection` writes it in the same compare-and-set as `activeRevision`, so each activated projection replaces the list. Noop and index-lag hydrates do not change it.
- The Workspace API (`GET /workspaces`, `GET /workspaces/{slug}`, create, patch, retry) returns `skippedFiles: [{ path, reason }]` (OpenAPI schema `WorkspaceSkippedFile`).
- `WorkspaceSettingsPane` shows a warning notice **Hydrate skipped N file(s)** when the list is not empty. Each row is a link that opens the file in **Files** and a reason: "Front matter could not be read" or "Repeats a repository that is already linked".
- Docs: a **Skipped files** section in `apps/docs/content/docs/(guide)/workspaces/knowledge-files.mdx`. preview-env HYD-2 expects the notice and `skippedFiles` in the Workspace JSON.

Proof:

- `apps/backend/src/routes/v1/workspace-skipped-files.integration.test.ts` (real Postgres, native git, real `workspace-hydrate` workflow, `GET` through the Workspace routes): a clean projection returns `[]`; a commit with a broken file and a repeated linked repository returns both entries; a commit that fixes the file and removes the repeat returns `[]`. The test fails when `commitHydrateProjection` does not persist the list.
- Storybook plays (MSW): `Components/Workspaces/SettingsPane` `Settings` (no notice) and `SkippedFiles` (title, both reasons, link calls `onOpenFile`); `Components/Workspaces/Pane` `SettingsSkippedFileOpensInFiles` (the link opens and selects the file tab in **Files**). Run in Chromium against a static build.

## Resolution
