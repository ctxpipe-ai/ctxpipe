# Show knowledge files skipped as malformed on the Workspace page

Status: needs-triage
Priority: P2 (proposed)
Owner: unassigned
Blocked by: none
Created: 2026-10-04
Updated: 2026-10-04

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

## Resolution
