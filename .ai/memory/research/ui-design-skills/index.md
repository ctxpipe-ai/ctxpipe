# UI / design agent skills

Research date: 2026-08-15

Scope: how coding agents produce designer-quality product UI from intent — public skills, practitioner reviews, and a Refactoring UI test matrix — then what this repo should own. Implementation lives in [`apps/ui/DESIGN.md`](../../../../apps/ui/DESIGN.md) and [`.agents/skills/product-ui/`](../../../../.agents/skills/product-ui/SKILL.md). This note is prior art, not the skill.

## Question

When someone describes UI intent (“add an empty state”, “list the three things this connector syncs”), how do we make agents ship tasteful Operate UI instead of generic AI SaaS or a marketing landing page?

## Sources

Practitioner writeups (Snyk skill roundup, Firecrawl, Medium “I tried 8”, Composio, Open Design, Impeccable docs, product-ui-design README) plus first-party repos. Star counts were treated as weak evidence; reviewers independently warned that some catalogs look campaign-inflated.

| Skill | What people keep it for | What they warn about | Fit for ctxpipe |
|-------|-------------------------|----------------------|-----------------|
| Anthropic [`frontend-design`](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | #1 install. Forces a design plan before code. Kills Inter / purple-gradient / cookie-cutter heroes. Taste-maker for **landing pages and portfolios**. | Optimized for *distinctive artifacts*. Pushes new type, atmosphere, signature moments. Those techniques **leak into dashboards** (glow, grain, hero CTAs). | **Do not install as always-on for `apps/ui`.** Fights Geist/teal and invents a new brand. Useful later only as a marketing/docs ceiling. |
| [`product-ui-design`](https://github.com/kuras3/product-ui-design) | Explicit counterpart to `frontend-design`. Register of Linear / Stripe / shadcn / GitHub. Observe a real reference, restrain, then hard-check AI tells (glowing dots, mono eyebrows, indigo, four-stat strips). | Newer, smaller community. “Tell-free” is the floor; *good* still needs named product DNA. | **Best conceptual match.** Our DNA is already chosen (Geist, teal, zinc-950, React Aria). |
| `no-slop-ui` / `de-ai-ui` | Ban lists: glass cards, dashboard heroes, decorative copy, `hover:scale-105`. | Defense only. A clean ban list without identity produces *blank* UI. | Steal the tell list; not the only skill. |
| [Impeccable](https://github.com/pbakaus/impeccable) | Most complete *workflow*: `PRODUCT.md` + `DESIGN.md`, brand vs product (or Persuade / Operate / Read / Experience) modes, 23 commands, 59 detectors. Started from `frontend-design` then split registers. | Heavy. Slash-command oriented. Auto-`document` from code can invent rationale. Easy to treat as a style guide instead of a partner. | Strong **process** ideas. Too much surface area to vendor wholesale. |
| [Google Stitch `DESIGN.md`](https://stitch.withgoogle.com/docs/design-md/overview/) | Persistent identity file: tokens (what) + prose (why). Agents stop guessing hex/radius. 30-day users report consistency, not creativity, as the win. | A file without a skill that *forces reading it* gets ignored. | **We should write one.** Tokens already live in `apps/ui/src/styles.css`. |
| [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines) | The quality gate people actually keep. 100+ audit rules: focus, forms, reduced motion, tabular-nums, empty states, URL state. | Review skill, not a builder. Fetches remote `command.md` each run. | Excellent **after** build. Overlaps React Aria. Optional later; out of scope for the first pass. |
| UI/UX Pro Max | Huge DB: 67 styles, 161 palettes, font pairings. Good for greenfield “beauty spa landing page.” | Too much choice → patchwork; produces *industry-looking* mass production; **fights an existing design system**. | **Skip for `apps/ui`.** Conflicts with [ADR-001](../../decisions/ADR-001-frontend-ui-app-stack.md). Optional later behind the prototype skill only. |
| Bencium UX Designer | Deep UX reference (a11y, motion spec, responsive). “Controlled” variant is consistency-first. | 28k-character dump; low stars; shadcn/Radix assumptions. | Mine motion/a11y tables; do not install as the primary skill. |
| AccessLint | Laser a11y (contrast, link purpose). | Extra MCP / tooling. | Defer. React Aria + a later audit is enough at first. |

**Security:** Snyk’s ToxicSkills work found prompt injection in a large share of third-party skills. Prefer first-party or a reviewed vendored copy — do not `npx` a design-database CLI into the monorepo.

**Independent pattern:** offense (taste) + defense (tell bans) + identity file (`DESIGN.md`) + audit. Installing only `frontend-design` is the common mistake for product apps.

## What identity + anti-slop still miss

A DESIGN.md plus a tell-scan still ships “list a few features” as a zinc `ul/li`. Brand tokens constrain Geist/teal/radius; a disc list still “matches the brand.” AI-tell lists flag indigo, glow, glass, Inter — a semantic bullet list is not a tell. Vercel guidelines flag missing labels and focus rings, not designed collections. React / Storybook skills say how to fetch data and add a story, not which information pattern to use.

The missing discipline is **information design**: user words are jobs, not HTML tags. Impeccable’s `shape` and Anthropic’s “structure is information” make the same move implicitly. We make it a **mandatory in-skill step** with a checkable done test — if it lives only in a disclosed appendix, agents skip it.

## Refactoring UI as a test suite

We cannot ingest or quote the copyrighted book. The official site publishes the full 50-chapter TOC ([refactoringui.com/book](https://www.refactoringui.com/book)). That list, plus widely published summaries, is the public test suite. A second pass read the uploaded PDF (252 pages) for worked-example failures the TOC alone misses. Skills encode *tactics as checkable house rules in our own words*. Do not vendor a third-party “refactoring-ui” skill, paste chapter text, or commit the PDF.

### Pass already (house system or catalog)

- Choose a personality / limit your choices — DESIGN.md + Geist / teal / zinc
- Use good fonts — already chosen; skill forbids new typefaces
- You need more colors / define shades — tokens exist; skill forbids raw hex and new palettes
- Don’t overlook empty states — catalog row
- Supercharge the defaults (bullets → icon rows, radios → cards) — information-design
- Don’t rely on color alone — status pills with text
- Leveling up (study real UI) — “open a nearby feature as the visual anchor”

### Fail or weak without in-skill hierarchy + visual-craft

These would still ship as “on brand” zinc markup if the skill only had tokens and a tell list:

| TOC tactic | Typical agent failure | Plan fix |
|------------|----------------------|----------|
| Start with a feature, not a layout | Redesigns AppShell / invents a new nav | In-skill: design the feature first; do not restyle the shell unless asked |
| Detail later / don’t design too much | Invents unbuilt attachments, extra tabs | Smallest useful version; empty/loading/error only for *this* feature |
| Not all elements equal / size isn’t everything | Huge `h1`, tiny muted body, everything same weight | Hierarchy pass: 2–3 text colors, 2 weights; de-emphasize with color/weight |
| Grey text on colored backgrounds | `text-zinc-400` on teal buttons, tinted alerts | Same-hue muted text on chromatic surfaces |
| De-emphasize to emphasize | Paints the hero louder instead of quieting neighbors | Mute competitors first |
| Labels are a last resort | `Name: Jane` / `Status: Ready` dumps | Drop obvious labels; combine remaining ones |
| Visual hierarchy ≠ document hierarchy | `h1` “Manage account” at `text-3xl` | Semantic heading, visual size of a label |
| Balance weight and contrast | Solid Tabler icons shout next to titles | Mute decorative icons; thicken a border before darkening it |
| Semantics are secondary | Every button solid teal; Delete always big red | One primary, outline secondary, link tertiary; filled red only on confirm |
| Start with too much space / dense UIs have a place | Marketing-airy or cramped | Start loose, then tighten to house density |
| Spacing system | `p-[13px]`, `gap-[22px]` | Tailwind/token scale only |
| Don’t fill the whole screen | Settings form stretched to 1400px | `max-w-*` for forms/prose |
| Grids are overrated | 25%/75% fluid sidebar | Do not percentage-size chrome |
| Relative sizing doesn’t scale | `em` padding on buttons | Independent scales |
| Ambiguous spacing | Same gap inside a field group as between groups | More space *around* a group than *within* it |
| Type scale | Random `text-[15px]` / `text-5xl` | DESIGN.md scale only |
| Line length 45–75ch | Help paragraphs full-bleed | Cap prose (`max-w-prose`) |
| Baseline, not center | Mixed sizes vertically centered on one row | Baseline-align mixed type |
| Line-height is proportional | `leading-loose` on titles, tight on small help | Tighter leading on large type |
| Not every link needs a color | Every row title teal | Weight/darker color in dense lists; teal for the one action |
| Align for readability | Centered 6-line empty-state essay | Left-align long text; right-align + `tabular-nums` on numbers |
| Letter-spacing | Tracked body; untracked all-caps | Don’t track body; open tracking on short all-caps only |
| Accessible ≠ ugly | Light-on-dark teal slabs that fight the page | Dark slabs stay; same-hue muted secondary, no opacity-as-grey |
| Light / elevation | Pure-black `shadow-lg` | House elevation; dark UI lifts with surface lightness |
| Overlap for depth | Random negative-margin overlap | Only if a nearby house screen already overlaps |
| Images / intended size / user uploads | Scaled-down screenshots, stretched logos | Crop in a fixed frame; enclose icons if the hit area must be large |
| Accent borders | Teal bar on every card | One accent at most |
| Decorate backgrounds | Gradients, grids, grain | Forbidden on the product floor |
| Use fewer borders | Card-in-card, every row boxed | Gap or bg shift first |
| Tables / dropdowns / radios | Spreadsheet of labeled cells; native radio stack | Combine cells; selectable cards; sectioned menus |
| Complex form / data dashboard | Ungrouped fields; four equal KPI tiles | Form sections + proximity; one protagonist metric |
| Landing-page video | Applies marketing tactics to settings | Out of scope for `apps/ui`; prototype skill only |

### Second pass: PDF worked examples (paraphrased)

The TOC-only pass still missed failures the book’s before/after examples make obvious. Rules added to `references/visual-craft.md` (house wording only):

| Book example (paraphrased) | Agent failure still allowed | Rule |
|----------------------------|-----------------------------|------|
| Mix square and rounded corners | `rounded-none` Button next to `rounded-md` input | One radius per surface; house default `rounded-lg` |
| Official vs friendly copy | “Utilize webhook configuration” vs casual slang | DESIGN.md locks copy register (plain, specific, not cute) |
| 12 vs 13px / 24 vs 25px | Arbitrary `h-[25px]`, `text-[15px]` | Pick from the scale by trying neighbors |
| De-emphasize with `font-light` | `font-thin` / weight < 400 | Never weight < 400 to quiet text; use color or size |
| Grey / white-at-50% on a colored panel | `text-white/50` on teal | Ban opacity-as-hierarchy on chromatic surfaces |
| Active nav still lost | Makes the active item louder | Mute **inactive** items first |
| Sidebar competing with content | Paints a second card-colored rail | Don’t add a sidebar fill unless the house screen already has one |
| `Name: Jane` / email / phone | Label:value dumps | Drop labels when format or context is enough |
| “Manage Account” as a huge `h1` | `text-3xl` page titles | Semantic `h1`, visual `text-lg` / `text-xl` on product screens |
| Soft 1px border too faint | Darkens the border until it’s noisy | Thicken to 2px before darkening |
| Save + Cancel + Delete all solid | Every action is a filled button | One primary; outline secondary; link tertiary |
| Narrow form stretched to match the nav | Full-bleed settings | `max-w` on the form; optional second column for help |
| Headline `2.5em` of body; button `p-[0.75em]` | Nested `em` type | Type in rem/px; button padding is its own scale |
| Label–input gap equals group gap | Fields feel ungrouped | Four proximity smells (see visual-craft) |
| 16–24px icon blown to 3–4× | `size-12` Tabler icons look chunky | Keep icons near intended size; enclose in a tinted square if the hit area must be large |
| Empty list with tabs and filters still showing | Dead chrome | Hide supporting UI until there is content |
| Supporting alert as a dark teal slab | Opacity-as-grey on the slab | Keep dark slabs; same-hue muted text |
| Bulleted “features” | `list-disc` | Icon + title + one-line rows |

Landing-page chapters and “invent a new palette” are **out of scope** for `apps/ui`.

## Audit: current `apps/ui` vs the target

Today’s UI is **not** treated as the gold standard. Several house patterns fail the same tests we want agents to apply. `DESIGN.md` records **decided** personality, not a dump of `styles.css`.

| Current pattern | Verdict | Locked decision |
|-----------------|---------|-----------------|
| `--radius: 0.625rem` vs mass `rounded-none` vs Button `rounded-lg` vs outline `rounded-sm` | Mixing radii almost always looks worse | Unify on ~8–10px (`rounded-lg`). Do not add `rounded-none` on **new** product chrome. Existing square overrides stay until a later pass. |
| AppShell teal + blue radial glow + 24px grid | Decorate-background + AI-slop tell | No grid and no glow on product chrome. Onboarding may keep atmosphere. |
| Card corner crosses | Unique signature | **Keep** |
| `ctx-label` mono uppercase + tracking | Product-UI skills call mono eyebrows a tell; we chose them as brand | **Keep** |
| Pulsing status dots | Glowing dots are a common tell; we pair them with text | **Keep** pulse **plus** a text label |
| Quiet-button teal hover glow | Glow-as-hover is a tell; we chose it as a rare accent | **Keep** |
| White/light `--primary`; teal is a side scale; leftover indigo `sidebar-primary` / `chart-1` | Confusing “primary” vs brand turquoise | White/light **primary** buttons; teal is accent, not the default filled CTA. Do not introduce indigo. |
| `text-3xl` / `sm:text-4xl` page titles | Visual hierarchy ≠ document hierarchy | Product screens `text-lg` / `text-xl`. `text-3xl`+ only on onboarding/marketing. |
| Centered empty state + long paragraph + outline CTA | Don’t center long copy; empty CTA should be primary | Short copy; **primary** CTA; hide tabs/filters until there is data; center only if copy ≤2 lines |
| `list-disc` feature/help lists | Supercharge defaults | Icon + title + one-line rows; `list-disc` only for legal/consent or true prose outlines |
| InlineAlert dark slabs + lucide + `opacity-95` | Opacity-as-grey; two icon sets | Keep dark slabs; no opacity-as-grey; same-hue muted secondary; Tabler first |
| Two icon libraries | Limit choices | Tabler first; Lucide only if Tabler has no equivalent; no third set |
| Destructive always filled red | Severity ≠ primary | Outline/quiet on the page; filled red only on the confirm dialog |

## Decision

**Option A, skills-only.** First-party `product-ui` skill + `DESIGN.md` + disclosed catalogs. Do not vendor Anthropic `frontend-design`, UI/UX Pro Max, or Impeccable as always-on. Do not paste Refactoring UI book prose/figures or commit the PDF. Optional Vercel audit skill is out of scope for this pass.

Layers:

| Layer | Owner | Job |
|-------|-------|-----|
| Identity | `apps/ui/DESIGN.md` | Tokens, type/spacing/elevation, unified ~10px radius, copy, brand signatures |
| Translate | in-skill step | UX job → pattern (not HTML noun → tag) |
| Hierarchy / layout | in-skill step | Primary/secondary/tertiary, proximity, max-width, fewer borders |
| Pattern catalog | `references/information-design.md` | List/status/empty/form/table/choose + exceptions |
| Visual craft | `references/visual-craft.md` | Refactoring UI tactics as yes/no house rules |
| Defense | `references/ai-tells.md` | Indigo leftover, glass, dashboard heroes, generic Inter — **not** our mono labels, status dots, or quiet glow |
| Implementation | existing `react` | Query, effects, keys |
| Catalog | existing `storybook` | Stories, don’t guess props |
| Explore | existing `prototype` | Radical variants; landing-page experiments stay here |

## Lesson

Do not install marketing `frontend-design` on product UI. Do not paste copyrighted book text into skills. See [lessons-learned.md](../../lessons-learned.md).
