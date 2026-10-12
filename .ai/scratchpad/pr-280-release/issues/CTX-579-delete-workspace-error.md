# CTX-579: deleting a Workspace shows an error before Home

Status: fixed on the PR branch (not pushed).

## Cause
After the DELETE, the settings pane called `removeQueries` for the Workspace
detail query in the `navigate().then` callback. The Workspace page is still
mounted at that time. Its next render built a new detail query, read it again,
got 404, and replaced the page with an error.

## Fix
The pane now removes every cache entry of the deleted Workspace only after the
pane unmounts (`WorkspaceSettingsPane.tsx`). The list update and the navigation
stay as they were.

## Tests
New Storybook plays in `WorkspaceSurface.stories.tsx`: `DeleteWorkspaceShowsNoError`,
`DeleteLastWorkspaceShowsNoError`, `DeleteFromConversationShowsNoError`. The
Workspace routes answer 404 after the DELETE. The stage keeps the Workspace
mounted for 1.5 s and renders it every 100 ms. Each play fails on the old code
and passes now. It checks for no error text, a success toast, and Home.

## Notes
`DeleteLastWorkspaceEmptiesHome` fails in a local dev Storybook run with and
without this change (composer not enabled). CI golden set is unchanged.
Not checked live on the preview.
