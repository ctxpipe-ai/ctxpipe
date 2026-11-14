# Connector components

The rules of the connector list and of the connector setup dialogs. The general product UI rules are in [`apps/ui/DESIGN.md`](../../../../DESIGN.md).

## Connector list (`ConnectorListItem`)

The Connectors page shows each connection as a tile. Each provider card (`GithubConnectionCard`, `LinearConnectionCard` and the others) renders `ConnectorListItem`.

- **Head of the tile:** the mark and the name are one button, and it opens and closes the details. There is no chevron.
- **Status:** a dot and its word (`connected`, `not yet connected`, `couldn't load`, `sync failed`, `config PR failed`) in one column of the same width on each tile. The color is on the dot only, and the word is muted. The dot pulses only for a live state (`checking`, `syncing`). A static state has a still dot. The word names the cause: do not use a generic "Error" chip or an orange alert icon.
- **Actions:** the overflow menu is at the end of the head. A setup that is not finished shows Remove and its next step in a row below the head.
- **Details:** "Used in", the account, and the text action link.
- **Page:** "Add connection" is a labeled primary button. GitHub is first (`sortOrgConnectionsForDisplay`). Do not put setup steps on the list: they belong in the setup dialog.
- **Linear and Notion:** "Manage scope" opens the scope editor (`manageScope`), not the "connected" screen.

## Setup dialogs (`ConnectorSetupFrame`)

Every connector setup dialog (Linear, Notion, Confluence, Slack, PagerDuty, Buildkite, Plain) renders its content in `ConnectorSetupFrame`, in a `Modal` with `flex flex-col`.

- **Zones:** a header with the `ctx-node` mark, a body, and a footer with the one Close button at the bottom right. There is no other close control.
- **Fit:** the dialog is never taller than the viewport. The header and the footer stay in view, and only the body scrolls.
- **One axis:** the mark of the header, the setup steps (`ConnectorSetupStepper`), the merge step, the form checkboxes and the list checkboxes all start on the left edge of the body. A scope list has top and bottom rules and no side padding, so its checkboxes are on that edge too.
- **Merge step:** "Merge the pull request" is the last item of the setup steps: `PullRequestsToMerge` as the `finalStep` of `ConnectorSetupStepper`. It is a selected item with semantic tokens (`bg-muted`, `ring-border`), not a zinc panel.
- **Tokens:** use semantic color tokens and `rounded-md`. Do not nest a card in a card. Do not add a filled `bg-zinc-900` panel.
