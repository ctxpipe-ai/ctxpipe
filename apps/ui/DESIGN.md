# Product UI identity (`apps/ui`)

Agents read this file before building or restyling user-visible product UI. It records **decided** personality, the tokens we keep, and the rules of the product UI — not a dump of `styles.css`, and not a license to restyle the whole app.

`apps/ui` is an **Operate** surface: dense, trusted and keyboard-heavy. It answers the click immediately — waiting chrome is a defect. **Ceiling** (large type, atmosphere) is onboarding and marketing only. Knowledge-graph may stay a bit more spatial but must not reintroduce page-wide glow or grid.

Implementation process: [`.agents/skills/product-ui/SKILL.md`](../../.agents/skills/product-ui/SKILL.md). React data flow: [`.agents/skills/react/SKILL.md`](../../.agents/skills/react/SKILL.md). Stories: [`.agents/skills/storybook/SKILL.md`](../../.agents/skills/storybook/SKILL.md).

**Product name:** In text, write the product name as "ctxpipe". Use "ctx|" only in the logo.

## Priority order

1. **Task clarity:** the user can tell what the screen is for, what each element does, and what to do next.
2. **Hierarchy and grouping:** the most important element leads, and related elements read as one group (**Gestalt lens**).
3. **State and feedback:** each state (loading, empty, error, done, long or missing content) shows clearly.
4. **Consistency:** the same meaning has the same look on every screen.
5. **Alignment and spacing:** edges, axes and space are even.
6. **Polish:** restraint and finish.

Accessibility is the floor under this list: no rule may make text unreadable, a control unreachable by keyboard, or a state visible by color only. When two rules conflict, follow the rule of the higher item, and never make a higher item worse to satisfy a lower one.

The sections of **Rules, in priority order** follow this list, and so do the qualities of the visual critic. Before you commit a rule-driven change to many screens, compare each changed screen with its previous state against the higher items.

## Personality (copy these)

- **Corners:** one radius, `rounded-md` (0.2rem). The `@theme` block in [`styles.css`](src/styles.css) sets every `--radius-*` step to 0.2rem, so each `rounded-*` step gives the same small corner. Apply it to new or touched controls, menus, cards, dialogs, and data surfaces. Use `rounded-full` only for a circle (status dot, switch thumb, radio, slider, progress bar). Do not use it for a pill. Do not add `rounded-none`.
- **Primary actions:** white / light filled buttons (`bg-primary` / `text-primary-foreground`). Teal (`#40E0D0` / `teal-*`) is the **accent**, not the default filled CTA.
- **Brand signatures (keep):**
  - Monospace for ids, paths, hashes and counts
  - A hairline border with a wide shadow on a modal, a popover and a toast
  - One font (Geist) and one palette
  - A status dot **plus** its word (not color-only)
- **Hover:** a quiet button (`variant="quiet"`) shows a subtle background wash on hover (`bg-foreground/[0.06]`).
- **Copy register:** ASD-STE100 at about 80% strength. “Add connection”, not “Let’s get you connected!” or “Utilize webhook configuration.”

## Tokens we keep

Use existing CSS variables and Tailwind theme stops. Prefer **named** utilities (`tracking-tighter`, `p-2`, `text-sm`) over arbitrary values (`tracking-[-0.5px]`, `p-[13px]`, `text-[15px]`). Do not invent a new palette, typeface, shadow recipe, or corner treatment.

### Type

| Role | Face | Scale |
|------|------|--------|
| UI body | Geist (`font-sans`) | `text-sm` default; `text-xs` for meta |
| Product screen title | Geist | Semantic `h1` at `text-lg` / `text-xl`. Content is the focus. |
| Onboarding / marketing title | Geist | `text-3xl`+ allowed here only |
| Section label in a dense panel | Geist Mono via `.ctx-label` | `text-xs` uppercase `tracking-[0.24em]`. See **House decisions** |
| Tokens, ids, hashes, paths, shortcuts | Geist Mono (`font-mono`) | `text-xs` / `text-sm`; `tabular-nums` on counts |
| Pixel / wordmark moments | Geist Pixel Square / Grid | Rare; do not use for body or form labels |

<!-- rubric: typography -->
UI text is Geist; ids, paths, hashes and counts are Geist Mono. Body is text-sm, meta is text-xs, a product title is text-lg or text-xl. No text is smaller than text-xs (12 px), also not a menu group header, inline code, a badge or a chart label. Weights are 400 and 500 only: quiet text uses color or size, never a lighter weight. Sizes come from the Tailwind scale. Prose lines stay at about 75 characters or less. A title of two or more lines does not end with one word alone.
<!-- /rubric -->

Leading: tighter on large type, looser on small / wide prose. Do not use `leading-loose` on titles.

Letter-spacing: do not track body copy. Open tracking on short all-caps only (`.ctx-label` already does this). Tight tracking uses `tracking-tight` / `tracking-tighter`, not `tracking-[-0.5px]`.

Pick sizes from the Tailwind scale by trying neighbors (`text-sm` ↔ `text-base`). Use `text-balance` on a title that can wrap.

### Color

Dark product floor: zinc-950 / `--background` / `--card`. Ink: `--foreground`. Supporting: `--muted-foreground`.

| Token | Role |
|-------|------|
| `--primary` (near-white in dark) | Filled primary buttons |
| `teal-400` (`#40E0D0`) and `teal-*` mix stops | Accent: links that are *the* action, status wash, focus-adjacent teal |
| `--destructive` | Confirm-dialog filled danger, and the slab of an error alert |
| `amber-*` / `yellow-*` | The border and the icon of a warning |
| `--border` / `border-white/10` | Hairlines |

<!-- rubric: color-tokens -->
Color comes from the house tokens: a zinc floor, a white primary, a teal accent. Red marks an error and the filled danger button of a confirm dialog. The dark UI has no large bright or saturated area: bright color is a small accent, such as a border, an icon or a dot, and a block has at most one teal edge or wash. A warning is a dark surface with a yellow or amber border and icon; a yellow fill with dark text is only for a small element, and only when it passes AA. An embedded editor, diff viewer or preview uses the dark theme. No indigo, no purple gradient, no second accent.
<!-- /rubric -->

Leftover shadcn indigo (`sidebar-primary` / `chart-1` hue 264) is not brand.

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
- **Animate only `opacity`, `transform` (`scale`, `translate`, `rotate`), and colors.** Do not animate `width`, `height`, `flex-grow`, or layout. A progress bar is a full-width bar with `origin-left` and `scale` (`transition-[scale]`), not a changing `width`. Do not use `transition-all`. Name the properties, for example `transition-[opacity,scale]`.
- **An optional block appears without a layout jump.** A block that may not show (the Get started guide) reserves no space while it loads. When it appears, run that state change in a view transition (`useRevealOnce`, which calls `document.startViewTransition`). Give the block and the blocks below it a `view-transition-name`, and set the group animation to 150 ms `ease-out` in [`styles.css`](src/styles.css). The browser then moves snapshots with transforms. Do this only on first appearance, and only without reduced motion. If a view transition does not fit, use a FLIP `translateY` on the blocks below. Never animate `height` or `grid-template-rows`.
- **Loading indicators can loop.** A spinner, a skeleton shimmer, and a pulse dot tell the user to wait. They do not move content. Their animation can be longer than 150 ms. Give a loader the `ctx-loading-motion` class (`animate-spin` is also a loader class).
- **Exception: graph camera moves.** A knowledge graph camera move (`fitView`, zoom) helps the user follow a node, so it can animate for 250 ms at most (`CAMERA_MOVE_MS`).
- **Exception: the hand-off from onboarding.** The product owner asked for this motion in CTX-868. When onboarding opens Home, Home stays hidden until its first data is ready. Then it fades in one time (`animate-in fade-in duration-100`). The rows of the welcome slide fade in one after another (100 ms each, delays of 150 ms at most). Use the exception for no other page.
- **Do not add a motion library.** Use Tailwind and CSS.
- **Reduced motion:** a global `prefers-reduced-motion: reduce` rule in [`styles.css`](src/styles.css) stops all transitions and animations. It does not stop a loader with `animate-spin` or `ctx-loading-motion`, because a loader must continue to show progress. Do not override the rule.

CI runs `node scripts/ci/check-ui-motion.mjs`. It fails on `transition-all` and on a transition or animation duration or delay above 150 ms in `src/`. It reads Tailwind classes, inline `style` objects, and CSS rules. A loader is exempt only when it has a loader class. For another real exception, write `motion-allow: <reason>` on the line or on the line before it (TS/TSX), or in the rule (CSS).

### Icons

`@tabler/icons-react` first. Lucide only when Tabler has no equivalent. Do not add a third set.

Decorative icons: `aria-hidden`, `text-muted-foreground`, intended size (~16–20px / `size-4`). If the hit area must be large, enclose the icon in a tinted square (`.ctx-node`) — do not scale the glyph to `size-12`. Do not use `.ctx-node` as an ornament, for example above the heading of an empty state.

## Rules, in priority order

Apply these rules on new or touched UI. Each rule is in one place. A block between `<!-- rubric: <id> -->` and `<!-- /rubric -->` is also the definition of that entry of the visual critic rubric (see **The visual critic**).

### Accessibility (the floor)

<!-- rubric: accessibility -->
Every user can read and reach the UI. Text and icons are readable on their surface. The keyboard focus ring is readable and not clipped. A state never shows by color only: a status has its word, and an error has its text.
<!-- /rubric -->

<!-- rubric: contrast -->
Text is readable on its surface: about 4.5:1 for body text and 3:1 for large text and icons. On a teal, red or amber slab, secondary text is a lighter stop of the same hue at full opacity, not white at reduced opacity. The text of an item that the user can click (a file tree, a nav list) is never so dim that it reads as disabled.
<!-- /rubric -->

Quiet text uses `text-muted-foreground` or brighter.

### Task clarity

<!-- rubric: clarity -->
The user can tell what the screen is for, what each element is and does, and what to do next. The current or next step of a task stands out from the steps around it. A button names its result with a verb and an object ("Save token", not "Submit"). Each form field has a visible label; a placeholder is only an example value. The screen shows what the task needs now; details, advanced options and machine text wait behind a disclosure.
<!-- /rubric -->

<!-- rubric: focus -->
The page has one primary action: one filled white button. Other actions are outline, quiet or a link. Teal marks only the one real action in a dense list.
<!-- /rubric -->

<!-- rubric: actions -->
Each control shows what it does: an icon tells its action, a chevron sits only on a row that opens or expands, and the main action of a page has a label, not a lone + icon.
<!-- /rubric -->

Destructive actions are outline or quiet on the page; filled red is only on the confirm dialog ([`AlertDialog`](src/components/ui/AlertDialog.tsx)).

<!-- rubric: dialog -->
A modal has a header, a body and a footer zone. It fits the viewport: the header and the footer stay in place, long content scrolls inside the body, and nothing is cut off at an edge of the screen. Each dialog and each step of a flow shows a way to close, cancel or go back, also when the screen would look cleaner without it.
<!-- /rubric -->

<!-- rubric: copy -->
Copy is plain and specific US English in every visible word, also a legend and a chart label (color, not colour). It tells the user what to do. Error copy gives the cause and a next step, and does not repeat the title. One row, card or dialog does not show the same text twice.
<!-- /rubric -->

### Hierarchy and grouping

<!-- rubric: hierarchy -->
One element leads: the title is the loudest ink, and the rest steps down. Hierarchy comes from weight and muted color, not from a size jump; neighbors and decorative icons are muted first. Each screen has a small budget of strong signals (a filled button, a bright color, a badge, a colored edge, an icon in a tile), and each one marks something that matters. Secondary chrome (legends, hints, help) is smaller and dimmer than the content and does not cover it.
<!-- /rubric -->

A first-run help tour can cover content until the user dismisses it. A dismissed hint or tour stays dismissed.

<!-- rubric: missing-elements -->
An addition or deletion region adds or removes an element. A label, an icon, a status word, a control or the frame of a block does not disappear without a reason.
<!-- /rubric -->

#### Gestalt lens

<!-- rubric: gestalt -->
Read each screen through the Gestalt principles. A screen that breaks one is a smell, also when no other rule names it.

- **Proximity:** less space inside a group than around it; an action sits at the thing it acts on.
- **Similarity:** the same meaning has the same look; peer actions share one weight.
- **Common region:** a surface, a frame or an inset holds each group; a card holds groups, not a second card.
- **Figure–ground:** a card, a tile or a row stands off the page by its surface or a clear border, not a dim hairline.
- **Continuity:** siblings share one edge and one marker axis; a child group steps in; a different edge marks a different role.
- **Prägnanz:** each block reads in its simplest form: one state signal, quiet items inside, space before a hairline.
<!-- /rubric -->

**Common fate** applies to motion only (see **Motion**).

### State and feedback

<!-- rubric: feedback-and-state -->
Each state uses its house pattern. A region wait is a skeleton with the box of the loaded state. A process wait is the teal loader. An empty state is a short title, one sentence and one primary control. An error is an inline alert with its cause and a next step. The layout holds at its edges: a long name, zero, one or many items, an error and a loading state keep the structure of the screen.
<!-- /rubric -->

- **Loading:** pick the kind of wait with the table of product-ui **Plan states**. Skeletons follow **Loading states**.
- **Empty states:** hide tabs and filters until there is data. Center only if copy is ≤2 lines; otherwise left-align. No icon tile above the title.
- **Alerts:** [`InlineAlert`](src/components/ui/InlineAlert.tsx) dark slabs. Prefer Tabler icons on new alerts.
- **Notices that wait for an action** (for example the Home upgrade toasts and Workspace hydrate problem toasts): toasts in a [`ToastStack`](src/components/ui/ToastStack.tsx) in a slot at the top of the Home content column, not a warning slab in the page. An upgrade toast has the upgrade icon; a problem toast has the warning icon. The front toast shows in full; hover or focus opens the stack.

<!-- rubric: status -->
A status is a dot and its word. The color is on the dot; the words share one restrained text color. A dot pulses only while the work runs (running, syncing, indexing); a static state has a still dot.
<!-- /rubric -->

Use the existing pill + dot ([`RepositoryStatus`](src/features/repositories/components/RepositoryStatus.tsx)).

<!-- rubric: overflow -->
Text, icons and focus rings fit their box. Nothing is cut off by a parent, nothing runs over a neighbor, and no element covers text. Long machine text (a URL, a token, an id, a stack trace, raw error text) never fills a message: a short sentence shows, and the detail is behind a disclosure or in a mono block with a capped height that scrolls. A signed URL or a value that looks like a secret never shows in full.
<!-- /rubric -->

<!-- rubric: broken-content -->
Labels, copy and field values show no rendering artifact: no undefined, null, NaN, [object Object], untranslated key, lorem ipsum or broken image. A missing value shows a dash or a short empty text. A code or file preview that shows such text as its content is not broken.
<!-- /rubric -->

### Consistency

<!-- rubric: consistency -->
Similarity holds across screens, so the change reuses the house primitives and patterns: one corner radius (rounded-md), the button variants, the status pill, the alert. No new font, hex color, corner treatment, shadow or card style.
<!-- /rubric -->

<!-- rubric: brand-fit -->
The surface reads as the ctxpipe Operate UI: dark zinc floor, white primary, teal accent, Geist type, monospace for ids, paths, hashes and counts. Large type and atmosphere stay on onboarding.
<!-- /rubric -->

Build with `src/components/ui/*` (React Aria). Do not invent a new Button, Input, or checkbox. Selected / focus / disabled states already live on those primitives. Pick each collection, status, empty, error and choice pattern from the catalog in product-ui [`information-design.md`](../../.agents/skills/product-ui/references/information-design.md).

### Alignment and spacing

<!-- rubric: spacing -->
Space and alignment follow the Gestalt principles of proximity and continuity. Space comes from the Tailwind scale. Text does not touch the edge of its button, card, pill or page. Long copy is left-aligned, never justified, and numbers are right-aligned with tabular figures.
<!-- /rubric -->

<!-- rubric: density -->
Operate density, as in chat, connectors and settings: tight, not landing-page air. Forms and prose keep a maximum width; data surfaces are full width.
<!-- /rubric -->

Start a little loose, then tighten. Forms and help use `max-w-*` / `max-w-prose` (~45–75ch). Do not stretch a settings form to match the nav.

### Polish

<!-- rubric: restraint -->
No generic AI decoration: no gradient, gradient text, glass, grain, glow or grid on product chrome, no hero type, no four equal KPI tiles, no teal on every row, no badge stacked above a title, no numbers on sections that are not a sequence, no icon tile above the heading of an empty state, no glow or drop shadow on hover. A colored edge on one side of a block marks a state, such as a block that needs the user; a colored stripe that marks no state is decoration. An in-page card has no hard offset shadow and no wide black shadow; a dialog, popover, menu or toast keeps its house shadow. A blurred backdrop behind a modal, an uppercase heading that names a page section, and a status dot with its word are not decoration.
<!-- /rubric -->

Replace a tell with the house element that the rules above name.

## Loading states

All skeletons follow one rule. The rule is in [`Skeleton.tsx`](src/components/ui/Skeleton.tsx).

- **Delay:** a skeleton is not visible for the first `SKELETON_DELAY_MS` (1000 ms). Before that time, the region keeps its final size but stays empty. Thus a fast load shows no skeleton. A CSS animation (`ctx-skeleton-wait`) runs the delay, so the delay starts at first paint, also for server HTML.
- **Hand-over:** when a skeleton of one thing hands over to a different skeleton of the same thing (for example the workspace skeleton to the Files pane skeleton), put both in a `SkeletonChain` with the same id, under one `SkeletonRegion`. The second skeleton then shows when the first one shows, so the area does not go blank. The chain takes its show time from the CSS animation, which starts at first paint. Skeletons of other chains keep their own delay. Give the chain id to `useSkeletonHold` and `SkeletonSuspense` too, so the hold starts when the chain shows.
- **Minimum time:** when a skeleton is visible, it stays for at least `SKELETON_MIN_MS` (300 ms). Use `useSkeletonHold(isPending)` for a query-driven skeleton. Use `SkeletonSuspense` in place of `Suspense`. Put wait text in a skeleton inside `SkeletonReveal`.
- **Match:** a skeleton has the same box as the loaded state: the same size, position, spacing and row height. A list skeleton follows the Rows rule, not the row count. Use the class names of the loaded component. Use `SkeletonText` for a text line, so that the bone row has the line height of the text.
- **Subtle:** bones are `bg-zinc-800/50` with a `white/5` shimmer. The bone has the `ctx-loading-motion` class, so the reduced-motion rule does not stop the shimmer.
- **Space:** a block that always shows keeps the space it will use while it loads. Its skeleton has the same height as the loaded block. A block that may not show (for example Get started) reserves no space while it loads. When it appears, a view transition (150 ms, ease-out) moves the blocks below with transforms, so they do not jump (see Motion). Never animate its height. With reduced motion, it appears without animation.
- **Rows:** a skeleton list shows at most 3 rows, with falling opacity (75%, 50%, 25%). Do not guess the full row count.
- **Proof:** a story with a play test shows that the skeleton box and the loaded box have the same size (for example `RecentCommitsSkeletonMatches`).

## House decisions

These are product owner decisions for ctxpipe. Some go against a common convention on purpose. Keep them until the owner changes them.

- **Card corner crosses** (2026-11-13, [CTX-1259](https://linear.app/ctxpipe/issue/CTX-1259)): only on a hero or summary card (the lead card of a page, an overview of metrics). No product card is one today, so [`Card`](src/components/ui/Card.tsx) has no crosses. Add them back, as an opt-in prop of `Card`, with the first hero or summary card.
- **Mono uppercase tracked labels** (`.ctx-label`, 2026-11-13, [CTX-1259](https://linear.app/ctxpipe/issue/CTX-1259)): only as a section label in a dense panel (graph inspector, node drawer, a scope checklist). Use the title alone above a page title or a card heading.
- **One close control** (2026-11-14, [CTX-1269](https://linear.app/ctxpipe/issue/CTX-1269)): many design systems put an X at the top of a dialog and a Cancel or Close button at the bottom. ctxpipe uses one.

<!-- rubric: dialog -->
A dialog has one close control. In a wizard, it is one Close button at the bottom right, with no second Close or X at the top.
<!-- /rubric -->

<!-- rubric: restraint -->
These ctxpipe signatures are not tells: the mono uppercase .ctx-label as a section label in a dense panel (not as an eyebrow above a page title or a card heading), and corner crosses on a hero or summary card.
<!-- /rubric -->

## The visual critic

The visual critic of the factory judges screenshots with the rubric in [`packages/visual-review/rubric.json`](../../packages/visual-review/rubric.json). That file comes from this one: the definition of each entry is the text of its rubric blocks, in the order of this file, and its sources are the headings of those blocks. Write a block so that a reviewer can judge it from a screenshot, and keep build details (class names, files) outside the block.

- After you edit a block, run `pnpm --filter @ctxpipe/visual-review rubric` to write `rubric.json`. A test fails while the two differ.
- A changed block changes the critic. [ADR-063](../../.ai/memory/decisions/ADR-063-visual-critic-decides-with-jev.md) rule 7 asks for a bake-off of the change (`factory eval visual:bakeoff`, on the host). Rule 7 says when the after run can run.
- The screenshot capture also measures three rules in each story: no text overflows or is clipped (`overflow`), the leading markers of a dialog or a list share one axis (`axes`), and text passes WCAG AA contrast (`contrast`). A failure fails the screenshot check of the story. The numbers of each check are in the storybook skill, "Layout checks", because the check needs them. To accept a rule in one story, give a reason in `parameters.visual.allow`.
