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

## Space and layout

| Check | Yes looks like |
|-------|----------------|
| Token scale | Tailwind steps only (`p-3`, `gap-4`, `p-6`). No `p-[13px]` / `h-[25px]` |
| House density | Chat / connectors tightness after a loose first pass — not landing-page air |
| Proximity | More space around a group than within it |
| Four proximity smells fixed | (1) label–input tighter than group–group (2) extra space *above* a heading (3) list gap > line-height (4) horizontal clusters share one gap |
| Form width | `max-w-*` on the fields; optional help column; inputs do not stretch to the nav |
| Prose width | `max-w-prose` / ~45–75ch even if a sibling screenshot is wider |
| Chrome width | AppShell sidebar stays fixed; do not percentage-size chrome |
| Independent scales | Type in rem/px; button padding is its own scale (tighter when the control is small). No `em`-tied padding |
| Baseline, not center | Mixed type on one row (title + meta, price + period) shares a baseline |
| Align for reading | Long copy left-aligned; numbers right-aligned + `tabular-nums` |
| Empty copy | ≤2 lines may center; longer copy left-aligns and gets rewritten shorter |
| Empty chrome | Tabs, filters, and search hidden until there is data |

## Type

| Check | Yes looks like |
|-------|----------------|
| Scale only | Neighbors on the Tailwind type scale; no `text-[15px]` / `text-5xl` on product screens |
| Leading proportional | Tighter on large titles; looser on small / wide help |
| Tracking | Body untracked; short all-caps use `.ctx-label` tracking |
| Links in a dense list | Weight or darker color; teal reserved for the one action. Hover-only for ancillary |

## Color on color

| Check | Yes looks like |
|-------|----------------|
| Same-hue muted on slabs | Dark red/teal/amber alert: secondary text is a lighter stop of that hue, full opacity |
| No opacity-as-grey | No `text-white/50` or `opacity-95` as hierarchy on chromatic surfaces |
| Status not color-only | Pill + icon or contrast + the word ([RepositoryStatus](../../../../apps/ui/src/features/repositories/components/RepositoryStatus.tsx)) |
| Accent once | At most one teal edge or wash; match an existing house use (alert edge, quiet hover) |

## Depth, radius, images

| Check | Yes looks like |
|-------|----------------|
| One radius | New chrome is `rounded-lg` / `--radius`. No new `rounded-none` mixed with `rounded-md` |
| Elevation | Surface lightness (`bg-card` vs page); existing rings. No black `shadow-lg` slabs |
| Overlap | Only if the nearby anchor screen already overlaps |
| Icon size | Glyph stays ~16–20px; large hit area uses `.ctx-node` enclosure |
| Figures | Crop to a fixed frame / `object-cover`; do not scale a screenshot until type is 4px |
| User art | Fixed frame + inner edge so avatars/logos do not bleed into zinc-950 |

## Finishing

| Check | Yes looks like |
|-------|----------------|
| Fewer borders | Gap or bg shift first; one hairline if needed; no card-in-card |
| Undecorated floor | No gradient, grid, grain, or map fill on Operate surfaces. Empty-state `.ctx-node` is the illustration exception |
| Defaults upgraded | React Aria controls; branded selected state; no native radio / default underline as the design |
| Operate, not Persuade | No landing-page heroes, atmosphere, or marketing type scale on settings / connectors / chat |

## Actions

| Check | Yes looks like |
|-------|----------------|
| One filled button | Primary is white/light. Secondary is outline. Tertiary is quiet / link |
| Destructive | Outline or quiet on the page; filled red only on the confirm dialog |
| No unbuilt chrome | Every control has a backend or was cut from this version |
