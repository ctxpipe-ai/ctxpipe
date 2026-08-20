---
name: product-ui
description: Product UI craft for apps/ui—translate intent to house patterns, hierarchy and layout, DESIGN.md identity. Use when building or restyling product screens, empty states, lists, forms, settings, or polish in apps/ui.
---

# Product UI (`apps/ui`)

Designer-quality Operate UI from intent. Identity lives in [`apps/ui/DESIGN.md`](../../../apps/ui/DESIGN.md). Implementation stays in the [react](../react/SKILL.md) and [storybook](../storybook/SKILL.md) skills. Radical / landing-page exploration stays in [prototype](../prototype/SKILL.md).

Do not install marketing `frontend-design` on this surface. Do not invent a palette, typeface, or shell.

## 1. Read identity

Open [`apps/ui/DESIGN.md`](../../../apps/ui/DESIGN.md). Apply it on **new or touched** UI. Existing `rounded-none` overrides stay until a later pass — do not add more of them.

**Done when:** you can name the radius (`rounded-lg`), primary (white/light), accent (teal), title scale (`text-lg` / `text-xl` on product screens), and which brand signatures you will reuse (crosses, `.ctx-label`, status pill + text, quiet glow).

## 2. Feature, not shell

Design the **feature content** first. Smallest useful version: the fields, rows, or CTA the user asked for. Empty / loading / error only for *this* feature. No implied attachments, extra tabs, or marketing chrome.

Leave `AppShell`, SideNav, and page-wide atmosphere alone unless the user asked to change them. Product chrome stays undecorated (no grid, no teal/blue glow).

When polishing a **named region** of existing chrome or a dense control list: change only that region — do not push experiments into shared class helpers that restyle siblings. After visual polish, **Tab** the surface once — focus rings, clipping, and non-outline affordances (resize line + arrows) are part of done. Use [`focus-styles.ts`](../../../apps/ui/src/lib/focus-styles.ts); see [DESIGN.md](../../../apps/ui/DESIGN.md) **Focus / keyboard** and [visual-craft.md](references/visual-craft.md) Finishing.

**Done when:** the planned surface is the feature; the shell is unchanged; every control has a backend or an explicit out-of-scope note.

## 3. Translate intent → pattern

User words are jobs, not HTML tags. For each chunk of UI, name:

1. **Job** — scan, compare, act, learn, or confirm? (Not “render a list.”)
2. **Shape of each item** — title only? title + supporting line? title + meta + action?
3. **Count and relationship** — 2–5 peers, a sequence, one protagonist + extras, or 20+ rows?
4. **Pattern** — pick from [references/information-design.md](references/information-design.md), or write one sentence justifying a new one.
5. **Primitive test** — if the markup is the HTML word the user said (`ul`, `table`, `form`, `p`) and nothing else, revise.

**Done when:** every user-facing collection, status, empty, error, and choice has a named pattern, and none is a bare HTML primitive unless the exception in that file applies (inline prose, legal/consent, true outline).

## 4. Hierarchy + layout pass

After the pattern, before code, name:

- **Primary / secondary / tertiary** on this surface (one primary action)
- **How hierarchy is made** — weight + muted color, not a size jump. Mute neighbors before painting the hero louder.
- **Grouping** — more space *around* a group than *within* it
- **Width** — `max-w-*` for forms/prose, or full-bleed data surface?
- **Separators** — gap or background shift first; one hairline if grouping is still ambiguous

**Done when:** those five are written, there is one primary action, and the plan does not use `text-3xl` on a product title, stretch a form to the nav, or box every row.

## 5. Observe a nearby screen

Open a shipped screen in the same feature (or the closest `components/ui` primitive). Steal unintuitive details: numbered step markers, hairline recipes, `.ctx-node` icon enclosure, pill + pulse + word, catalog rows that are a `ul` used as layout.

**Done when:** you can point at the anchor file and name two details you will copy.

## 6. Plan states

For this feature only: empty, loading, error, and dense data.

Empty: short title + one sentence + **one primary** control. Hide tabs, filters, and search until there is content. Center only if copy is ≤2 lines; otherwise left-align.

Loading: a skeleton that mirrors the final pattern (not “Loading…”). Selected chrome (tabs, pane switchers) updates **on the click**; the skeleton stays inside the region that needs data. A click that waits for a route loader before the tab moves is not done.

Error: [`InlineAlert`](../../../apps/ui/src/components/ui/InlineAlert.tsx) + a next step. Dark slab, same-hue muted secondary, no `text-white/50`.

**Done when:** each state has a pattern; empty chrome is hidden; the empty CTA is `variant="primary"`; selected chrome does not wait on a loader.

## 7. Build

- Primitives from `src/components/ui/*` (React Aria). Do not invent a new Button or checkbox.
- **React Aria first:** tabs, dialogs, menus, lists, links, and similar controls start from [React Aria Components](https://react-spectrum.adobe.com/react-aria/components.html). Use the house wrapper in `src/components/ui/*` when the visual matches; otherwise compose RAC primitives (`Tabs` / `TabList` / `Tab`, `Button`, `Link`, …) and style them. Hand-rolled `<button>` tablists are not a substitute for `Tabs`.
- New chrome: `rounded-lg` / `--radius`. Do not add `rounded-none`.
- Icons: `@tabler/icons-react` at ~16–20px, `text-muted-foreground`, `aria-hidden`. Lucide only if Tabler has no equivalent. Enclose in `.ctx-node` if the hit area must be large.
- Destructive on the page: `outline` or `quiet`. Filled red only on [`AlertDialog`](../../../apps/ui/src/components/ui/AlertDialog.tsx).
- Copy: UK English, plain, specific. Semantic `h1` at `text-lg` / `text-xl` on product screens.
- **Feel fast:** chrome must move on the click. Do not put in-page tab/pane search in route `loaderDeps`. Load the region with local `Suspense`. See [react](../react/SKILL.md) **Feel fast**.
- **Responsive — CSS-first:** Express breakpoints with Tailwind (`sm:`, `md:`, `lg:`, `max-md:`, …) — visibility, padding, borders, column layout, overlay vs rail. Reach for JS (`matchMedia`, `useMediaQuery`, resize Effects) **only when CSS cannot do the job** (interactive state like an open drawer; a one-shot `matchMedia` inside a click handler is fine). Do not drive layout chrome from reactive media-query state when a responsive class would suffice.

Then follow the [react](../react/SKILL.md) skill for data flow.

**Done when:** the markup matches the named pattern, uses existing primitives, the title/radius/icon rules above hold, responsive behaviour is CSS-first, and chrome moves on the click.

## 8. Scan

Run all three. Fix before considering the UI done.

**Noun test** — did I implement the HTML word or the job? Feature/capability copy is icon + title + one-line rows, not `list-disc`.

**Craft** — apply every yes/no in [references/visual-craft.md](references/visual-craft.md) to this output.

**Tell-scan** — apply [references/ai-tells.md](references/ai-tells.md). Our mono labels, status dots + text, quiet glow, and card crosses are brand, not tells.

**Done when:** every craft rule is a yes (or an explicit N/A), no tell remains, and the noun test passes for every collection.

## 9. Story

Add or update a colocated Storybook story for the new or touched surface. Follow the [storybook](../storybook/SKILL.md) skill.

**Done when:** a story exists for the visible state you shipped (empty, error, populated — whichever you added).
