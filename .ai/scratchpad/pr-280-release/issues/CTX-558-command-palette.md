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

Golden plays in `WorkspaceCommandPalette.stories.tsx`: `PaletteShortcutTogglesAndRestoresFocus`, `PaletteShortcutClosesAfterSyncRender`, `PaletteArrowKeysWalkEveryItem`, `PaletteHoverAndKeysShareOneHighlight`, `PaletteEnterAfterDeleteRunsFirstMatch`, `PaletteSkeletonHandsOverOnce`, `PaletteFiltersAtOnce`, `PaletteArrowKeysAndEnterKeepPane` (also checks `?pane=files` and `selectNav`), `PaletteEscapeClearsThenCloses`, `PaletteNoResults`, `PaletteLoadingKeepsPages`.

## Review and keyboard fixes

- The Workspaces section shows only after the skeleton hold ends, so there is one header. The skeleton header waits for the same delay as the bones.
- A hidden live region (`output`) announces "N results", "No results for “…”" and "Loading workspaces".
- Sections use the shared `MenuSection title`. The footer says "Esc Clear" with a query and "Esc Close" without one.
- Bug found by hand in the workspace page: Cmd+K did not close the open palette. Autocomplete sends a copy of each key from the field to the menu. The copy passed the window listener again and opened the palette again. The listener now stops the key, and it is one stable listener (`useEffectEvent`).
- Bug found by hand in the workspace page: Escape after Tab closed the dialog with text in the field. The field wrapper now clears the search on Escape before React Aria sees the key.
- Hover did not move the active item, so the hover fill and the keyboard item showed two highlights. A layer in each item now moves the active item on hover, and the hover fill is off.
- React Aria clears the active item when text is deleted. Enter then runs the first match.

## Keys checked by hand

Playwright with real key presses in Storybook dev: the isolated palette (`Open`, `PaletteLoadingKeepsPages`) and the full workspace page (`Pages/Workspaces/Compose`, with SideNav). The host dev stack was not used.

| Key | Result |
|-----|--------|
| Cmd+K / Ctrl+K (page) | Opens; again closes (fixed); focus goes back to the element that had it (composer or Search button) |
| Arrow Down / Up | Move through each item, from the last workspace to Home and back; the list wraps at both ends |
| Home / End | First / last item (the caret does not move) |
| Page Up / Page Down | Move by a page; an item stays active; the dialog stays open |
| Typing | First match is active at once; typing after an arrow press makes the first match active |
| Backspace | React Aria clears the active item; Enter still runs the first match |
| Enter | Runs the active item, closes, keeps `?pane=` |
| Escape | Clears the search (also after Tab, fixed), then closes |
| Tab / Shift+Tab | Focus stays in the field |
| Mouse hover then arrows | One highlight; arrows go on from the hovered item |
| Long list (20 workspaces) | The active item scrolls into view at each step |
| While loading | Arrows wrap over Home and Connectors; typing and Enter run a page |

## Follow-up

- The SideNav Search row shows `⌘K` also on Windows and Linux. It is outside this ticket (SideNav chrome).
