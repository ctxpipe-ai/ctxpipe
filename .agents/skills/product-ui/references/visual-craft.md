# Visual craft (house rules)

Yes/no checks in our voice. Apply every row to the UI you just built (skill step 8). N/A is allowed when the surface has no type / form / image / etc.

These encode widely used interface tactics as **ctxpipe house rules**. They are not a reprint of any book. Use our screens as examples, not third-party figures.

## Hierarchy

| Check | Yes looks like |
|-------|----------------|
| One primary action | Filled white/light button; everything else outline, quiet, or a text link |
| Hierarchy from weight + muted color | Title `font-medium` + body `text-muted-foreground`; not a `text-3xl` jump |
| Neighbors muted first | Inactive nav / secondary actions quieter before the active item gets louder |
| Decorative icons muted | Tabler `text-muted-foreground` at ~16–20px; title is the loudest ink on the row |
| Labels supporting | Drop “Name:” when the value is obviously a name; combine (“12 left”). Flip only when the user scans for the *label* |
| Semantic ≠ visual | Product `h1` is `text-lg` / `text-xl`. `text-3xl`+ is onboarding / marketing only |
| Weight ≥ 400 | Quiet text with color or size, not `font-light` / `font-thin` |
| Soft border too faint | Thicken to 2px before darkening the stroke |
| Secondary chrome quiet | Legends, hints and help are smaller and dimmer than the content and do not cover it. A help tour remembers its dismissal |
| Page has structure | Tiles or cards with hierarchy and area boundaries, as on the chat page. Not a flat list of bare rows |

## Space and layout

| Check | Yes looks like |
|-------|----------------|
| Token scale | Tailwind steps only (`p-3`, `gap-4`, `p-6`). No `p-[13px]` / `h-[25px]` |
| House density | Chat / connectors tightness after a loose first pass — not landing-page air |
| Proximity | More space around a group than within it |
| Four proximity smells fixed | (1) label–input tighter than group–group (2) extra space *above* a heading (3) list gap > line-height (4) horizontal clusters share one gap |
| Inner padding | Text does not touch the edge of its button, card, pill or page |
| Form width | `max-w-*` on the fields; optional help column; inputs do not stretch to the nav |
| Prose width | `max-w-prose` / ~45–75ch even if a sibling screenshot is wider |
| Chrome width | AppShell sidebar stays fixed; do not percentage-size chrome |
| Independent scales | Type in rem/px; button padding is its own scale (tighter when the control is small). No `em`-tied padding |
| Baseline, not center | Mixed type on one row (title + meta, price + period) shares a baseline |
| Align for reading | Long copy left-aligned; numbers right-aligned + `tabular-nums` |
| One left edge | The blocks of one column share a left edge (message, answer, composer; icon row, checklist, step card) |
| Hierarchy before axis | A child group (nested list, options of one choice, scope of one item) is inset 12 px or more, or framed, under its parent. Never flatten nesting to align markers |
| Shared marker axis | Header icon, checkboxes, step numbers and list icons of the siblings at one level share one vertical axis, each centered on its text line |
| Whole screen | A rule-driven fix keeps the hierarchy, block shape, signal weight and size of each screen that it changes |
| Balanced space | Space spread evenly across a row and a column; no element jammed against one neighbor with a large gap on its other side |
| Dialog fits | The dialog fits the viewport; header and footer stay in place; long content scrolls in the body; nothing cut off at an edge |
| Chips have room | A chip, badge or icon tab has space on each side from its neighbors |
| Modal grid | A modal has a header, a body and a footer zone on one aligned grid |
| Empty copy | ≤2 lines may center; longer copy left-aligns and gets rewritten shorter |
| Empty chrome | Tabs, filters, and search hidden until there is data |

## Type

| Check | Yes looks like |
|-------|----------------|
| Scale only | Neighbors on the Tailwind type scale; no `text-[15px]` / `text-5xl` on product screens |
| Leading proportional | Tighter on large titles; looser on small / wide help |
| Tracking | Body untracked; short all-caps use `.ctx-label` tracking |
| Minimum size | No text below `text-xs` (12 px) |
| Title line breaks | A title of two or more lines does not end with one word alone on its line (`text-balance`) |
| Links in a dense list | Weight or darker color; teal reserved for the one action. Hover-only for ancillary |

## Color on color

| Check | Yes looks like |
|-------|----------------|
| Same-hue muted on slabs | Dark red/teal/amber alert: secondary text is a lighter stop of that hue, full opacity |
| No opacity-as-grey | No `text-white/50` or `opacity-95` as hierarchy on chromatic surfaces |
| Status not color-only | Pill + icon or contrast + the word ([RepositoryStatus](../../../../apps/ui/src/features/repositories/components/RepositoryStatus.tsx)) |
| Readable contrast | Text meets WCAG AA on its surface: 4.5:1 for body text, 3:1 for large text and icons. Quiet text uses `text-muted-foreground` |
| Accent once | At most one teal edge or wash; match an existing house use (alert edge, status wash) |
| Status color on the dot | Dot + word; the word is one restrained text color, and the dots and words of a list share one column |
| Accessible warning | A dark surface with a yellow or amber border and icon; a yellow fill only on a small element and only when it passes AA. Red is for an error |
| One warning signal | One frame, or one icon with one colored line, for each warning or error block. No side border + colored dots + boxed alerts together; inner items say their state in quiet text |
| No bright areas | No large bright or saturated area on the dark floor; bright color as a small accent. Editors, diff viewers and previews use the dark theme |
| Clickable list text readable | A file tree or nav item is never so dim that it reads as disabled |

## Depth, radius, images

| Check | Yes looks like |
|-------|----------------|
| One radius | New chrome is `rounded-md` (0.2rem, from the `--radius-*` theme tokens). No new `rounded-none` mixed with the house radius |
| Elevation | Surface lightness (`bg-card` vs page); existing rings. No black `shadow-lg` slabs |
| Visible surface | A tile, card or row differs from the page by its surface, a border that is easy to see, or both. Not a thin dim border on the page color |
| Block keeps its shape | A status block, step or result keeps the surface, frame and icon that show what it is; not flattened into bare text |
| Overlap | Only if the nearby anchor screen already overlaps |
| Icon size | Glyph stays ~16–20px; large hit area uses `.ctx-node` enclosure |
| Figures | Crop to a fixed frame / `object-cover`; do not scale a screenshot until type is 4px |
| User art | Fixed frame + inner edge so avatars/logos do not bleed into zinc-950 |

## Finishing

| Check | Yes looks like |
|-------|----------------|
| Fewer borders | Gap or bg shift first; one hairline if needed; no card-in-card |
| Undecorated floor | No gradient, grid, grain, or map fill on Operate surfaces. No icon tile above an empty-state title |
| Defaults upgraded | React Aria controls; branded selected state; no native radio / default underline as the design |
| Operate, not Persuade | No landing-page heroes, atmosphere, or marketing type scale on settings / connectors / chat |
| Focus ring readable | `outline-2` / `offset-1` / `teal-400/60`; `focus-visible:z-10` over neighbors. Use [`focus-styles.ts`](../../../../apps/ui/src/lib/focus-styles.ts). Not full-bright teal; not browser-default |
| Outline CSS sane | No `outline-none` if hover/focus still use outline — use `outline-0` + solid, then grow/recolor. Persistent transparent width avoids hover flash |
| Hover ≠ focus | Soft hover wash can differ (wider matching-color outline, fill); keyboard focus stays the shared product ring |
| Rings not clipped | No parent `overflow-hidden` eating outlines; edge items trade padding→margin; focusable control shares the same radius as the painted hit target |
| Scoped style edits | When polishing one region, do not push experiments into shared class helpers that restyle sibling regions |
| Splitter / resize a11y | Focus shows the hover line (not a box outline); arrow keys nudge the value |
| Selected chrome on press | Tab, nav row, and switcher highlight move in the click handler. Skeleton stays inside the region. First HTML still has the landing files/data |
| Loading matches the pattern | Region wait is a skeleton of the populated rows. `"Loading…"` and a centered spinner are not the UI when the shape is already a list, tree, or pane |
| No raw values | Labels, copy and field values show no `undefined`, `null`, `NaN`, `[object Object]`, untranslated key, lorem ipsum or broken image. A missing value shows a dash or a short empty text. A code or file preview shows its content as it is |
| Visible labels | Each form field has a visible label. A placeholder is an example value, not the label |
| No repeated text | One row, card or dialog does not show the same text twice (a title and a body that say the same thing) |
| Machine text small | A URL, token, id, stack trace or raw error stays behind “Show details” or in a capped mono block that scrolls. No signed URL or secret-like value in full |
| Named Tailwind first | `tracking-tighter`, `p-2`, `text-sm` — not `tracking-[-0.5px]`, `p-[13px]`, or `text-[15px]` unless no named token is close |

## Actions

| Check | Yes looks like |
|-------|----------------|
| One filled button | Primary is white/light. Secondary is outline. Tertiary is quiet / link |
| Destructive | Outline or quiet on the page; filled red only on the confirm dialog |
| No unbuilt chrome | Every control has a backend or was cut from this version |
| Icon means its action | No chevron on a row that does not open; no bare icon whose result is not clear |
| Main action labeled | The main action of a page has a label (“Add connection”), not a lone `+` |
| Peers match | Peer actions in one row have the same weight and type (two buttons, or two links) |
| One close control | One Close per modal; in a wizard, at the bottom right |
| Always an exit | Each dialog and each step of a flow shows a way to close, cancel or go back. A cleaner screen is no reason to remove one |
| Copy at the field | A copy button sits at the right end of its field |
| Next step is a card | The next step of a flow is a card or a selected item, not loose text |
| Alert action | On the right of the slab, at the normal secondary size |
