# Connector components

The rules of the connector list and of the connector setup dialogs. The general product UI rules are in [`apps/ui/DESIGN.md`](../../../../DESIGN.md).

## Connector list (`ConnectorListItem`)

The Connectors page shows each connection as a tile. Each provider card (`GithubConnectionCard`, `LinearConnectionCard` and the others) renders `ConnectorListItem`.

- **Head of the tile:** the mark and the name are one button, and it opens and closes the details. There is no chevron.
- **Status:** a dot and its word (`connected`, `not yet connected`, `couldn't load`, `sync failed`, `config PR failed`) in one column of the same width on each tile. The color is on the dot only, and the word is muted. The dot pulses only for a live state (`checking`, `syncing`). A static state has a still dot. The word names the cause: do not use a generic "Error" chip or an orange alert icon.
- **Actions:** the overflow menu is at the end of the head. A setup that is not finished shows Remove and its next step in a row below the head.
- **Status read failed:** the tile shows the cause and a Retry button in a row below the head, so the user sees the next step without a click. The provider card gives no text of its own for this state.
- **Details:** "Used in", the account, and the text action link (a React Aria button).
- **Page:** "Add connection" is a labeled primary button. GitHub is first (`sortOrgConnectionsForDisplay`). Do not put setup steps on the list: they belong in the setup dialog.
- **Linear and Notion:** "Manage scope" opens the scope editor (`manageScope`), not the "connected" screen.

## Setup dialogs (`ConnectorSetupFrame`)

Every connector setup dialog (Linear, Notion, Confluence, Slack, PagerDuty, Buildkite, Plain) renders its content in `ConnectorSetupFrame`, in a `Modal` with `flex flex-col`.

- **Zones:** a header with the `ctx-node` mark, a body, and a footer with the one Close button at the bottom right. There is no other close control.
- **Fit:** the dialog is never taller than the viewport. The header and the footer stay in view, and only the body scrolls.
- **One axis for siblings:** the mark of the header, the setup steps (`ConnectorSetupStepper`), the marker of the merge step and the form checkboxes start on the left edge of the body. A step marker has the 18 px box of a checkbox, so the markers share one center line (the `axes` layout check).
- **Hierarchy before alignment:** a scope list (teams and projects, channels, pipelines, spaces) is a child group. It keeps its frame (`rounded-md border border-border`), and its checkboxes start 12 px inside the frame. Do not remove the frame or the inset to put the checkboxes on the body edge.
- **Merge step:** "Merge the pull request" is the last item of the setup steps: `PullRequestsToMerge` in the `mergeStep` of `ConnectorSetupStepper`. It is a selected item with semantic tokens (`bg-muted`, `ring-border`), not a zinc panel.
- **Tokens:** use semantic color tokens and `rounded-md`. Do not nest a card in a card. Do not add a filled `bg-zinc-900` panel.
