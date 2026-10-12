# CTX-558: rebuild the command palette (Cmd+K) on React Aria Autocomplete

Status: done on `ui/ctx-558-command-palette` (not pushed).

## Audit of the old palette

Source: `apps/ui/src/features/workspaces/WorkspaceCommandPalette.tsx` and its stories. The browser preview tool could not take snapshots of the pr-280 preview in this session, so this audit comes from the code and the Storybook stories.

### Usability

1. The list is a plain `<ul>` of `<button>` elements. It has no `menu` or `listbox` role, so arrow keys do not move through the results.
2. Enter in the search field does nothing. To run a command from the keyboard, the user must press Tab many times.
3. No item is active when the user types, so there is no "type, then Enter" flow.
4. Escape closes the dialog at once. It does not clear the search first.
5. The search text stays after Escape or an outside click. When the user opens the palette again, it shows the old filter. Only a run command clears it.
6. The filter also matches the hint text. Each page has the hint "page", so the query "page" matches Home and Connectors.
7. While Workspaces load, the skeleton replaces the full list, also Home and Connectors, which do not need data. The user cannot go to Home until the workspace list loads.
8. The dialog is centered vertically. Its height changes as the user types, so the search field moves up and down.
9. The empty state says "No results found." It does not repeat the query.
10. Pages and workspaces are in one list with no section headers.

### UI and design guidelines

11. The row hover is `hover:bg-zinc-900` on a `zinc-950/95` dialog. It is almost invisible. The rows have no focus style from the design system.
12. Long workspace names do not truncate. The name and the slug can overflow the row.
13. The slug is shown as a mono hint on each workspace row and the word "page" on each page row. The "page" hint gives no information.
14. The rows do not use the shared `Menu` / `ListBox` item styles. The dialog does not use the shared `Dialog` heading or labels.
15. No keyboard hints show in the palette (arrow keys, Enter, Esc).

### Accessibility

16. The dialog has no accessible name.
17. The search field has the generic label "Search". The list has no label.
18. The loading row puts `aria-busy` on an `li` in a list without a role.

### Dead code

19. `apps/ui/src/components/ui/CommandPalette.tsx` is a starter-kit copy that nothing imports. It opens on Cmd+J and adds a global Escape handler. Delete it.

### Keep

- Cmd+K / Ctrl+K toggles the palette (`SideNav` owns the open state).
- Navigation calls `selectNav` before `navigate`, with the same prefetch helpers as `SideNav`.
- `search: (prev) => prev` keeps `?pane=` on Home and on workspaces.
- The workspace list shows a skeleton (`useSkeletonHold`) while it loads.
- All three data sources (Home, Connectors, the workspace list) are useful. None is broken.

## Rebuild

- `react-aria-components` 1.15.1 has `Autocomplete`. No upgrade was necessary.
- `WorkspaceCommandPalette` uses `Autocomplete` + the shared `SearchField` + the shared `Menu` / `MenuItem` in the shared `Modal` (`placement="top"`, so the field does not move when the list changes) and `Dialog`.
- Virtual focus stays in the field. Arrow keys move, Enter runs the active item, and the first match is active after each key. Escape clears the search, and a second Escape closes the dialog. The modal gives focus back to the element that had it.
- Sections: Workspaces (name, then the slug in mono) and Pages (Home, Connectors). The filter matches the name or the slug, not the old "page" hint.
- The modal unmounts the body on close, so the search starts empty each time.
- While the workspace list loads, a Workspaces skeleton (`useSkeletonHold`, row height of a loaded row) shows above the Pages section. Pages stay usable. The empty state ("No results for “…”") waits for the list. A failed list shows one line of text.
- Names and slugs truncate. A footer row shows the keys (arrow keys, Enter, Esc).
- Labels: dialog "Command palette", field "Search workspaces and pages", menu "Results".
- The unused `components/ui/CommandPalette.tsx` is deleted, with its typecheck entries in `scripts/ci/diagnostics/ui.json`.

## Tests

Golden plays in `WorkspaceCommandPalette.stories.tsx`: `PaletteShortcutTogglesAndRestoresFocus`, `PaletteFiltersAtOnce`, `PaletteArrowKeysAndEnterKeepPane` (also checks `?pane=files` and `selectNav`), `PaletteEscapeClearsThenCloses`, `PaletteNoResults`, `PaletteLoadingKeepsPages`.

## Follow-up

- The SideNav Search row shows `⌘K` also on Windows and Linux. It is outside this ticket (SideNav chrome).
