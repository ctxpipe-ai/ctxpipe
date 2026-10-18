# Product UI identity (`apps/ui`)

Agents read this file before building or restyling user-visible product UI. It records **decided** personality and the tokens we keep — not a dump of `styles.css`, and not a license to restyle the whole app.

`apps/ui` is an **Operate** surface: dense, trusted, keyboard-heavy, dark zinc, white primary, teal accent. It answers the click immediately — waiting chrome is a defect. Region waits use skeletons; process waits use the teal loader. **Ceiling** (large type, atmosphere) is onboarding and marketing only. Knowledge-graph may stay a bit more spatial but must not reintroduce page-wide glow or grid.

Product chrome uses one radius: `rounded-md` (0.2rem). Apply it to new or touched controls, menus, cards, dialogs, and data surfaces.

Implementation process: [`.agents/skills/product-ui/SKILL.md`](../../.agents/skills/product-ui/SKILL.md). React data flow: [`.agents/skills/react/SKILL.md`](../../.agents/skills/react/SKILL.md). Stories: [`.agents/skills/storybook/SKILL.md`](../../.agents/skills/storybook/SKILL.md).

## Personality (copy these)

- **Corners:** `rounded-md` (0.2rem). The `@theme` block in [`styles.css`](src/styles.css) sets every `--radius-*` step to 0.2rem, so each `rounded-*` step gives the same small corner. Use `rounded-full` only for a circle (status dot, switch thumb, radio, slider, progress bar). Do not use it for a pill. Do not add `rounded-none`.
- **Primary actions:** white / light filled buttons (`bg-primary` / `text-primary-foreground`). Teal (`#40E0D0` / `teal-*`) is the **accent**, not the default filled CTA.
- **Brand signatures (keep):**
  - Card corner crosses from [`Card.tsx`](src/components/ui/Card.tsx)
  - Mono uppercase tracked labels (`.ctx-label`)
  - Pulsing status dots **plus** a text label (not color-only)
  - Quiet-button teal hover glow (`variant="quiet"`)
- **Copy register:** US English. ASD-STE100 at about 80% strength. Plain and specific. “Add connection”, not “Let’s get you connected!” or “Utilize webhook configuration.”

## Tokens we keep

Use existing CSS variables and Tailwind theme stops. Prefer **named** utilities (`tracking-tighter`, `p-2`, `text-sm`) over arbitrary values (`tracking-[-0.5px]`, `p-[13px]`, `text-[15px]`). Do not invent a new palette, typeface, shadow recipe, or corner treatment.

### Type

| Role | Face | Scale |
|------|------|--------|
| UI body | Geist (`font-sans`) | `text-sm` default; `text-xs` for meta |
| Product screen title | Geist | Semantic `h1` at `text-lg` / `text-xl`. Content is the focus. |
| Onboarding / marketing title | Geist | `text-3xl`+ allowed here only |
| Eyebrow / section label | Geist Mono via `.ctx-label` | `text-xs` uppercase `tracking-[0.24em]` |
| Tokens, ids, hashes, paths, shortcuts | Geist Mono (`font-mono`) | `text-xs` / `text-sm`; `tabular-nums` on counts |
| Pixel / wordmark moments | Geist Pixel Square / Grid | Rare; do not use for body or form labels |

Weights: `font-normal` (400) and `font-medium` (500). Never quiet text with weight below 400. De-emphasize with `text-muted-foreground` or size, not `font-light` / `font-thin`.

Leading: tighter on large type, looser on small / wide prose. Do not use `leading-loose` on titles.

Letter-spacing: do not track body copy. Open tracking on short all-caps only (`.ctx-label` already does this). Tight tracking uses `tracking-tight` / `tracking-tighter`, not `tracking-[-0.5px]`.

Pick sizes from the Tailwind scale by trying neighbors (`text-sm` ↔ `text-base`). Do not invent midpoints (`text-[15px]`, `h-[25px]`).

### Color

Dark product floor: zinc-950 / `--background` / `--card`. Ink: `--foreground`. Supporting: `--muted-foreground`.

| Token | Role |
|-------|------|
| `--primary` (near-white in dark) | Filled primary buttons |
| `teal-400` (`#40E0D0`) and `teal-*` mix stops | Accent: links that are *the* action, quiet-button hover, status wash, focus-adjacent teal |
| `--destructive` | Confirm-dialog filled danger only |
| `--border` / `border-white/10` | Hairlines when gap or bg shift is not enough |

On chromatic surfaces (teal / red / amber slabs): same-hue muted secondary text. Do not use `text-zinc-400` or `text-white/50` as hierarchy on those slabs.

Leftover shadcn indigo (`sidebar-primary` / `chart-1` hue 264) is not brand. Do not introduce indigo, purple gradients, or a second accent.

### Space

Tailwind spacing scale only (`gap-2`, `p-3`, `p-6`, `gap-7`). No arbitrary px (`p-[13px]`, `gap-[22px]`).

House density is chat / connectors / settings — start a little loose, then tighten. Marketing-airy whitespace belongs on onboarding only.

Proximity: more space *around* a group than *within* it. Field-to-label is tighter than field-group-to-field-group. List row gap is larger than line-height.

Width: `max-w-*` / `max-w-prose` (~45–75ch) for forms and help. Full-bleed is for data surfaces (virtualized lists, tables). Do not stretch a settings form to match the nav.

### Elevation

Dark UI lifts with **surface lightness** (`bg-card` vs `bg-background`, `bg-zinc-900` vs `bg-zinc-950`), not photo-real chrome. Use existing ring/border recipes (`ring-zinc-800`, `border-border`). Do not add `shadow-lg` black slabs or skeuomorphic inset buttons.

### Focus / keyboard

Operate UI is keyboard-heavy. Apply on **new or touched** interactive chrome:

- **Focus ring:** `outline-2` + `outline-offset-1` + `outline-teal-400/60` (readable, not full-bright). Raise `z-index` on `focus-visible` so the ring paints over neighbors.
- **Do not** use `outline-none` when you still need outline-based hover/focus — prefer `outline-0` + solid style, then grow width on focus.
- **Hover vs focus:** a soft hover wash (fill and/or a wider transparent outline) is separate from the focus ring; changing focus must not remove the hover treatment.
- **Clipping:** avoid parent `overflow-hidden` that cuts rings; give edge controls margin by reducing padding the same amount; match `rounded-md` on the actual focusable control.
- **Special affordances:** resize / splitter controls show the same line as hover on focus (no box outline) and move with arrow keys.

Shared tokens: [`focus-styles.ts`](src/lib/focus-styles.ts) (`focusVisibleClassName`, `focusVisibleRingClassName`, RAC `focusRing`). Re-exported from [`react-aria-utils.ts`](src/lib/react-aria-utils.ts) for primitives.

### Motion

Motion must not make the UI feel slow. Obey these rules in new and changed code:

- **Large components do not move.** Do not animate a pane, a panel, a drawer, a sidebar, page or route content, a layout change, or a resize. The change occurs at once.
- **Small elements can move, but only fast.** Examples are a hover color, a focus ring, a menu, a tooltip, a toast, a dialog fade, and a chevron. Use 150 ms or less. Use 100 ms when possible. The Tailwind default (`transition`, `transition-colors`) is 100 ms, so do not add a `duration-*` class to a `transition-*` utility. An `animate-in` or `animate-out` class needs `duration-100`, because the tw-animate-css default is 150 ms.
- **Show what changed with a small cue.** When an action hides or replaces a large component, the small control that reverses the action fades in (`animate-in fade-in duration-100 ease-out`). Examples are the pane triggers after Hide pane, the conversation title after Maximize, and Show tree after Hide tree. A new tab fades in and scrolls into view.
- **Use `ease-out` when an element comes into view.** An animation when the element goes out of view is optional. If you use one, it must not be longer than the first animation.
- **Animate only `opacity`, `transform` (`scale`, `translate`, `rotate`), and colors.** Do not animate `width`, `height`, `flex-grow`, or layout. Do not use `transition-all`. Name the properties, for example `transition-[opacity,scale]`.
- **Loading indicators can loop.** A spinner, a skeleton shimmer, and a pulse dot tell the user to wait. They do not move content. Their animation can be longer than 150 ms. Give a loader the `ctx-loading-motion` class (`animate-spin` is also a loader class).
- **Exception: graph camera moves.** A knowledge graph camera move (`fitView`, zoom) helps the user follow a node, so it can animate for 250 ms at most (`CAMERA_MOVE_MS`).
- **Exception: the hand-off from onboarding.** The product owner asked for this motion in CTX-868. When onboarding opens Home, Home stays hidden until its first data is ready. Then it fades in one time (`animate-in fade-in duration-100`). The rows of the welcome slide fade in one after another (100 ms each, delays of 150 ms at most). Use the exception for no other page.
- **Do not add a motion library.** Use Tailwind and CSS.
- **Reduced motion:** a global `prefers-reduced-motion: reduce` rule in [`styles.css`](src/styles.css) stops all transitions and animations. It does not stop a loader with `animate-spin` or `ctx-loading-motion`, because a loader must continue to show progress. Do not override the rule.

CI runs `node scripts/ci/check-ui-motion.mjs`. It fails on `transition-all` and on a transition or animation duration or delay above 150 ms in `src/`. It reads Tailwind classes, inline `style` objects, and CSS rules. A loader is exempt only when it has a loader class. For another real exception, write `motion-allow: <reason>` on the line or on the line before it (TS/TSX), or in the rule (CSS).

### Icons

`@tabler/icons-react` first. Lucide only when Tabler has no equivalent. Do not add a third set.

Decorative icons: `aria-hidden`, `text-muted-foreground`, intended size (~16–20px / `size-4`). If the hit area must be large, enclose the icon in a tinted square (`.ctx-node`) — do not scale the glyph to `size-12`.

## Targets (new or touched UI)

- **AppShell / product chrome:** no 24px grid and no teal/blue radial glow. Onboarding may keep atmosphere. Do not add background decoration (gradients, grain, world maps, Hero Patterns).
- **Titles:** product screens `text-lg` / `text-xl`. `text-3xl`+ only on onboarding / marketing.
- **Alerts:** keep dark slabs ([`InlineAlert`](src/components/ui/InlineAlert.tsx)); no opacity-as-grey; same-hue muted secondary text on the slab. Prefer Tabler icons on new alerts.
- **Empty states:** short title + one sentence + **one primary** control. Hide tabs/filters until there is data. Center only if copy is ≤2 lines; otherwise left-align.
- **Loading:** region waits (list, tree, thread, pane) use [`Skeleton`](src/components/ui/Skeleton.tsx) that matches the populated pattern (see **Loading states**). Process waits (hydrate, OAuth, discovery) use [`InlineLoader`](src/components/ui/InlineLoader.tsx). Button mutations use `isPending`. Status uses a pulse-dot plus the word. See product-ui **Plan states**.
- **Lists:** icon + title + one-line body rows for features / capabilities. `list-disc` only for legal / consent or a true prose outline (see [`KnowledgeGraphIntroCallout`](src/features/knowledge-graph/KnowledgeGraphIntroCallout.tsx)).
- **Destructive:** outline or quiet on the page. Filled red only on the confirm dialog ([`AlertDialog`](src/components/ui/AlertDialog.tsx)).
- **Actions:** one primary per surface; outline / secondary next; link / quiet for tertiary. Teal is for the one real action in a dense list — not every row title.
- **Separators:** gap or background shift first; one hairline if grouping is still ambiguous. Borders are a last separator. Do not nest cards inside cards.
- **Status:** existing pill + pulse/dot **and** the word ([`RepositoryStatus`](src/features/repositories/components/RepositoryStatus.tsx)). Not color-only. Not a glowing dot without a label.

## Loading states

All skeletons follow one rule. The rule is in [`Skeleton.tsx`](src/components/ui/Skeleton.tsx).

- **Delay:** a skeleton is not visible for the first `SKELETON_DELAY_MS` (1000 ms). Before that time, the region keeps its final size but stays empty. Thus a fast load shows no skeleton. A CSS animation (`ctx-skeleton-wait`) runs the delay, so the delay starts at first paint, also for server HTML.
- **Hand-over:** when a skeleton of one thing hands over to a different skeleton of the same thing (for example the workspace skeleton to the Files pane skeleton), put both in a `SkeletonChain` with the same id, under one `SkeletonRegion`. The second skeleton then shows when the first one shows, so the area does not go blank. The chain takes its show time from the CSS animation, which starts at first paint. Skeletons of other chains keep their own delay. Give the chain id to `useSkeletonHold` and `SkeletonSuspense` too, so the hold starts when the chain shows.
- **Minimum time:** when a skeleton is visible, it stays for at least `SKELETON_MIN_MS` (300 ms). Use `useSkeletonHold(isPending)` for a query-driven skeleton. Use `SkeletonSuspense` in place of `Suspense`. Put wait text in a skeleton inside `SkeletonReveal`.
- **Match:** a skeleton has the same box as the loaded state: the same size, position, spacing, row count and row height. Use the class names of the loaded component. Use `SkeletonText` for a text line, so that the bone row has the line height of the text. When one skeleton hands over to a different skeleton, put both in one `SkeletonChain`.
- **Subtle:** bones are `bg-zinc-800/50` with a `white/5` shimmer. The bone has the `ctx-loading-motion` class, so the reduced-motion rule does not stop the shimmer.
- **Proof:** a story with a play test shows that the skeleton box and the loaded box have the same size (for example `RecentCommitsSkeletonMatches`).

## Primitives

Build with `src/components/ui/*` (React Aria). Do not invent a new Button, Input, or checkbox. Selected / focus / disabled states already live on those primitives.

## What not to invent

- A new font, hex color, or corner treatment
- A new AppShell, sidebar fill, or page-wide glow/grid
- Landing-page heroes, glass cards, four-stat strips, or Inter
- Unbuilt attachments (paperclip with no backend)
- Extra tabs, filters, or marketing chrome on an empty surface
