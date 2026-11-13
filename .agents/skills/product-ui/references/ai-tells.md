# AI tells (defense)

Scan the UI you just built (skill step 8). These are generic-model defaults that fight this product. **Our brand signatures are not tells** — do not “clean them off.”

## Brand, not tells

Keep and reuse:

- Monospace for ids, paths, hashes and counts
- A hairline border with a wide shadow on a modal, a popover and a toast
- A status dot **plus** its word
- White/light primary buttons with teal as accent

Use with care (see [DESIGN.md](../../../../apps/ui/DESIGN.md) **Personality**):

- Card corner crosses: only on a hero or summary card (`corners` on [`Card`](../../../../apps/ui/src/components/ui/Card.tsx))
- `.ctx-label`: only as a section label in a dense panel, never as an eyebrow above a title
- A pulsing dot: only for a live state

## Tells to remove

| Tell | Replace with |
|------|----------------|
| Inter, system-ui as the designed face, or a newly imported display font | Geist / Geist Mono / rare Pixel (already loaded) |
| Indigo / violet / purple gradient (including leftover `sidebar-primary` / `chart-1` hue 264) | Zinc floor + teal accent + white primary |
| Glass cards, blur slabs, grain, mesh, Hero Patterns, world-map fills | Flat zinc surfaces; gap or one hairline |
| Page-wide teal + blue radial glow or 24px grid on product chrome | Undecorated AppShell. Atmosphere stays on onboarding |
| Dashboard hero: huge title, gradient orb, four equal KPI tiles | Feature content first; one protagonist metric if any |
| `hover:scale-105`, bounce-in cards, decorative Lottie | Existing transition tokens; motion only when it explains state |
| Every row title teal / every button filled teal | Weight/darker color in lists; one primary; teal for the one action |
| Glowing dot with no word, or a pulsing dot on a static state | House pill + dot **and** the word; pulse only while the work runs |
| A glow or drop shadow on hover | A subtle background or border change from the house tokens |
| An icon tile above the heading of an empty state | The title, one sentence, and the one action |
| Text smaller than `text-xs` (12 px) | `text-xs` or larger |
| Centered six-line empty essay + outline CTA + visible empty tabs | Short copy; primary CTA; hide chrome until there is data |
| `list-disc` feature/benefit rows | Icon + title + one-line rows |
| Gradient text on a title or a number | Solid `text-foreground` ink |
| On an in-page card or surface: a thick colored stripe on one side, a hard offset shadow, or a hairline border with a wide shadow | A surface lightness shift or one hairline (DESIGN.md **Elevation**). A dialog, popover, menu or toast keeps its house shadow |
| A pill badge stacked above a title, or numbers on sections that are not a sequence | The title alone. Numbers only for real steps. No `.ctx-label` eyebrow above a title |
| A button that does not say what it does (“Submit”, “OK”, “Go”) | A verb and its object that name the result (“Add connection”, “Save token”) |
| Cute or corporate-filler copy (“Let’s get you set up!”, “Utilize…”, “Unlock the power of…”) | Plain, specific US English. ASD-STE100 at about 80% strength |
| A second icon library or custom SVG set | Tabler first; Lucide only if Tabler has no equivalent |

## Ceiling vs Operate

Large type, atmosphere, and signature moments belong on onboarding / marketing (or a [prototype](../../prototype/SKILL.md) exploration). They are tells when they leak onto settings, connectors, repositories, or chat.
