# Add a Diff pane and a per-turn list of changed files in the conversation

Status: in progress
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

A Workspace conversation changes files in its sandbox. Today the user sees the changes only in the Files pane tree markers (added and modified) and in single-file views. The CTO wants a review flow like the one in common coding tools. Two reference screenshots were given on 2026-10-11, one of a Diff pane and one of a changed-files card. Copy their layout and interaction, and apply our styling (apps/ui/DESIGN.md).

## Spec (from the CTO)

### 1. Diff pane in the right pane

- A new "Diff" tab in the Workspace right pane, next to the existing tabs.
- It lists every changed file of the conversation against its base:
  - a status icon (added, modified, deleted, renamed);
  - the path, shortened from the left when it is long;
  - a copy-path button;
  - `+added −removed` line counts.
- The header shows the base (for example `origin/main`), the total `+N −M`, a refresh button, and expand-all and collapse-all.
- Each file row expands to its diff in place. A unified or split toggle and a wrap toggle are optional if `@pierre/diffs` gives them at no extra cost.
- Use the Pierre libraries (`@pierre/diffs`, and `@pierre/trees` if it helps), as ADR-040 says.

### 2. Changed files at the end of a turn

- When a turn changed files, show a card at the end of that turn. The card shows:
  - "N changed files" with the turn's `+added −removed`;
  - the files grouped by folder, with counts per folder;
  - a collapse control;
  - an "Open diff" action.
- The card shows only that turn's changes, not the whole conversation's.
- Clicking a file opens the Diff pane with that file expanded and in view. "Open diff" opens the Diff pane for the turn's files.

## Acceptance criteria

- [ ] The Diff pane lists the conversation's changes with correct statuses and counts, and expands each file to its diff.
- [ ] The card at the end of a turn shows only the files that turn changed, with correct counts, and it stays correct after reload.
- [ ] Clicking a file in the card opens the Diff pane on that file.
- [ ] Storybook stories with play tests cover the Diff pane (empty, many files, expanded file, long paths) and the turn card (collapsed, expanded, a click that opens the diff).
- [ ] Any backend change for per-turn data has integration tests. Any schema column or migration is approved by the CTO first.
- [ ] UI and backend tests and golden stories pass.

## Comments

## Resolution

- Diff pane: `WorkspaceConversationDiff.tsx`, data from `files/diff` (now with `base`). Counts come from the Pierre parse of the before and after bodies.
- Turn data: tree snapshots at turn start and end (refs `refs/ctxpipe/turns/<run>/start|end`), the changed-file list in `chat_metadata`. Route `GET …/files/turns`; `files/diff?turn=<run>` gives one turn's bodies.
- Turn card: `ConversationTurnChangesCard.tsx`, placed through `ConversationThread` `renderAfterTurn`.
- Open: no route-level test for `files/turns`; the turn number is the count of user messages in the run at its end.
