# Make the Diff tab match Files, Graph and Settings

Status: done
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-11
Updated: 2026-10-11

## Context

Ticket 34 added a Diff tab to the Workspace right pane. The CTO checked it on 2026-10-11 and found three differences from the other pane tabs (Files, Graph and Settings).

## Spec (from the CTO)

1. When the right pane is closed, the Diff trigger button does not show. It must behave as Files, Graph and Settings do: their trigger buttons show at the top right of the conversation panel when the pane is closed. Ticket 33 removed the border from those triggers.
2. The tab icon must be `file-diff`, from the icon library that the other pane tabs use.
3. When the Diff tab is active, the top-left corner of the pane content is square. It must be round, as it is when Graph or Settings is active. Make the rule generic for each tab, so that a new tab cannot miss it.

## Acceptance criteria

- [x] With the pane closed and the branch changed, the Diff trigger shows next to Files, Graph and Settings, with the same style and no border.
- [x] The Diff tab and the Diff trigger use the `file-diff` icon.
- [x] With Diff active, the top-left `border-radius` of the pane content is the same as with Graph active.
- [x] Diff is one more entry in the shared tab list, not a special case.
- [x] Storybook play tests cover the three points, and fail before the change.
- [x] UI tests and golden stories pass.

## Comments

- 2026-10-11, claude: `usePaneToolTabs` in `WorkspacePane.tsx` gives the tool tabs in strip order. The pane strip and the closed-pane triggers both show this list. Diff is in the list when the conversation branch differs from the default branch, or when the Diff pane is open.
- The icon is `IconFileDiff` from `@tabler/icons-react`.
- Before, the pane card had a square top-left corner when Files or Diff was active. Now the card has a square corner only when the active tab leads the strip (`toolTabs[0]`). The resize handle uses the same rule.

## Resolution

Done on branch t38-diff-tab-polish. Golden stories `DiffTriggerPaneClosed` and `DiffTabRoundedCorner` prove the change.
