# Product UI identity (`apps/ui`)

Agents read this file before building or restyling user-visible product UI. It records **decided** personality and the tokens we keep — not a dump of `styles.css`, and not a license to restyle the whole app.

`apps/ui` is an **Operate** surface: dense, trusted, keyboard-heavy, dark zinc, white primary, teal accent. It answers the click immediately — waiting chrome is a defect. **Ceiling** (large type, atmosphere) is onboarding and marketing only. Knowledge-graph may stay a bit more spatial but must not reintroduce page-wide glow or grid.

Existing square (`rounded-none`) overrides stay until a later pass. Apply the target below on **new or touched** UI. Do not add more square chrome.

Implementation process: [`.agents/skills/product-ui/SKILL.md`](../../.agents/skills/product-ui/SKILL.md). React data flow: [`.agents/skills/react/SKILL.md`](../../.agents/skills/react/SKILL.md). Stories: [`.agents/skills/storybook/SKILL.md`](../../.agents/skills/storybook/SKILL.md).

## Personality (copy these)

- **Radius:** unify on ~8–10px (`--radius: 0.625rem` / `rounded-lg`). One radius per surface. Do not mix `rounded-none` with `rounded-md` on the same screen. Do not add `rounded-none` on new product chrome.
- **Primary actions:** white / light filled buttons (`bg-primary` / `text-primary-foreground`). Teal (`#40E0D0` / `teal-*`) is the **accent**, not the default filled CTA.
- **Brand signatures (keep):**
  - Card corner crosses from [`Card.tsx`](src/components/ui/Card.tsx)
  - Mono uppercase tracked labels (`.ctx-label`)
  - Pulsing status dots **plus** a text label (not color-only)
  - Quiet-button teal hover glow (`variant="quiet"`)
- **Copy register:** UK English. Plain, specific, not cute. “Add connection”, not “Let’s get you connected!” or “Utilize webhook configuration.”

## Tokens we keep

Use existing CSS variables and Tailwind theme stops. Do not invent a new palette, typeface, shadow recipe, or third radius.

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

Letter-spacing: do not track body copy. Open tracking on short all-caps only (`.ctx-label` already does this).

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
- **Clipping:** avoid parent `overflow-hidden` that cuts rings; give edge controls margin by reducing padding the same amount; match `rounded-lg` on the actual focusable control.
- **Special affordances:** resize / splitter controls show the same line as hover on focus (no box outline) and move with arrow keys.

Shared tokens: [`focus-styles.ts`](src/lib/focus-styles.ts) (`focusVisibleClassName`, `focusVisibleRingClassName`, RAC `focusRing`). Re-exported from [`react-aria-utils.ts`](src/lib/react-aria-utils.ts) for primitives.

### Icons

`@tabler/icons-react` first. Lucide only when Tabler has no equivalent. Do not add a third set.

Decorative icons: `aria-hidden`, `text-muted-foreground`, intended size (~16–20px / `size-4`). If the hit area must be large, enclose the icon in a tinted square (`.ctx-node`) — do not scale the glyph to `size-12`.

## Targets (new or touched UI)

- **AppShell / product chrome:** no 24px grid and no teal/blue radial glow. Onboarding may keep atmosphere. Do not add background decoration (gradients, grain, world maps, Hero Patterns).
- **Titles:** product screens `text-lg` / `text-xl`. `text-3xl`+ only on onboarding / marketing.
- **Alerts:** keep dark slabs ([`InlineAlert`](src/components/ui/InlineAlert.tsx)); no opacity-as-grey; same-hue muted secondary text on the slab. Prefer Tabler icons on new alerts.
- **Empty states:** short title + one sentence + **one primary** control. Hide tabs/filters until there is data. Center only if copy is ≤2 lines; otherwise left-align.
- **Lists:** icon + title + one-line body rows for features / capabilities. `list-disc` only for legal / consent or a true prose outline (see [`KnowledgeGraphIntroCallout`](src/features/knowledge-graph/KnowledgeGraphIntroCallout.tsx)).
- **Destructive:** outline or quiet on the page. Filled red only on the confirm dialog ([`AlertDialog`](src/components/ui/AlertDialog.tsx)).
- **Actions:** one primary per surface; outline / secondary next; link / quiet for tertiary. Teal is for the one real action in a dense list — not every row title.
- **Separators:** gap or background shift first; one hairline if grouping is still ambiguous. Borders are a last separator. Do not nest cards inside cards.
- **Status:** existing pill + pulse/dot **and** the word ([`RepositoryStatus`](src/features/repositories/components/RepositoryStatus.tsx)). Not color-only. Not a glowing dot without a label.

## Primitives

Build with `src/components/ui/*` (React Aria). Do not invent a new Button, Input, or checkbox. Selected / focus / disabled states already live on those primitives.

## What not to invent

- A new font, hex color, or radius
- A new AppShell, sidebar fill, or page-wide glow/grid
- Landing-page heroes, glass cards, four-stat strips, or Inter
- Unbuilt attachments (paperclip with no backend)
- Extra tabs, filters, or marketing chrome on an empty surface
