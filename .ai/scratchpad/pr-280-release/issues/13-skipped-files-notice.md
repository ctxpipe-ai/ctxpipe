# Show knowledge files skipped as malformed on the Workspace page

Status: done
Priority: P2
Owner: implementation sub-agent
Blocked by: none
Created: 2026-10-04
Updated: 2026-10-06

## Context

Hydrate (`apps/backend/src/domain/workspaces/hydrate.ts`) skips a knowledge file whose front matter it cannot parse, and a linked-repository declaration that is unparsable or repeats a repository, and records `{ path, reason: "malformed" }` in `skipped`. The `workspace-hydrate` workflow returns that list as `diagnostics` in its run result (`openworkflow/workflows/workspace-hydrate.ts`), and nothing else keeps it. The Workspace still reaches **Hydrate ready**, so a user whose file vanished from chat, MCP, and the graph has no way to see why: the file is in **Files** (it is in git) but not in the projection.

Found while writing the browser critical-flow catalogue (ticket 06, flow HYD-2). User decision (2026-10-04): create this ticket.

## Goal

A Workspace member can see which knowledge files the current projection skipped, and why, from the Workspace page.

## Acceptance criteria

- [x] The skipped list of the active projection (path and reason) is persisted with the revision and returned by the Workspace API.
- [x] The Workspace page shows a notice when the list is not empty, naming each file (a link to it in **Files**) and the reason in plain words; nothing is shown when it is empty.
- [x] A new hydrate of a fixed file clears the notice.
- [x] Storybook play for the notice (MSW) and a backend test with a real database for the persisted list.
- [x] Public docs (`apps/docs/content/docs/(guide)/workspaces/`) say what a skipped file is and how to fix it.
- [x] preview-env HYD-2 expects the notice instead of recording "no UI surface".

## Plan

1. Triage: confirm priority and whether it ships in PR 280.
2. Decide where the notice lives (Settings hydrate chip, **Files** tree badge, or both) with the product-ui skill.
3. Persist, expose, render; tests as above.

## Open questions

None. `not_knowledge` is removed. The notice is in **Settings** only.

## Delegation brief

Read `domain/workspaces/hydrate.ts`, `openworkflow/workflows/workspace-hydrate.ts`, the Workspace status API and its UI consumer (Settings hydrate chip), `.ai/memory/PRDs/workspaces.md`, and `.cursor/skills/product-ui/`. Keep the change to one persisted field plus one UI notice.

## Comments

### 2026-10-06 — current state

The list is the `skipped` key of `hydrate_phases` (`HydratePhaseRecord.skipped: HydrateSkip[]`). There is no new column and no migration. `commitHydrateProjection` writes `skipped` on that object in the compare-and-set. Later `||` merges do not set the key, so they keep the list.

`HydrateSkip.reason` is `malformed` or `duplicate_repository`. `hydrateKnowledgeTree` takes the Workspace URL. A `repositories/` file that names that repository is `duplicate_repository`. The hydration contract test commits that file and fails when the hydrate run omits the Workspace URL. The test runs the index workflow, then reads the stored list.

Only `GET /workspaces/{slug}` returns `skippedFiles`, next to `linkedRepositories`. The route description holds the reason text. The handler passes the stored list through. In the UI, `skippedFiles` is absent on a detail seeded from the list.

**Settings** shows **Hydrate skipped N file(s)** when the list is not empty. Each row links to the file in **Files**. The reasons are "Front matter or git URL is not valid" and "Repeats a linked repository or the Workspace's own repository". The notice also names search. The docs and HYD-2 use the same copy.

Proof is `hydration.contract.test.ts`, test "atomically replaces published units while reporting a malformed sibling". It checks the stored list, `skippedFiles` on the detail response, a re-hydrate of the same SHA, and a commit that fixes the file. The `SkippedFiles` story checks the title, both reasons, and the link. The Pane story checks that the link opens the file.

## Resolution

A Workspace member sees the skipped files of the active projection on **Settings**. The list lives on `hydrate_phases.skipped` and `GET /workspaces/{slug}` returns it as `skippedFiles`. A later hydrate replaces the list. The hydration contract test and the `SkippedFiles` story prove the path.
