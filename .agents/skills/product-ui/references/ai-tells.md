# AI tells (defense)

Scan the UI you just built (skill step 8). These are generic-model defaults that fight this product. **Our brand signatures are not tells** — do not “clean them off.”

## Brand, not tells

Keep and reuse:

- Card corner crosses ([`Card.tsx`](../../../../apps/ui/src/components/ui/Card.tsx))
- `.ctx-label` — Geist Mono, uppercase, tracked
- Pulsing status dots **plus** a text label
- Quiet-button teal hover glow (`variant="quiet"`)
- White/light primary buttons with teal as accent

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
| Glowing dot with no word | House pill + pulse/dot **and** the word |
| Centered six-line empty essay + outline CTA + visible empty tabs | Short copy; primary CTA; hide chrome until there is data |
| `list-disc` feature/benefit rows | Icon + title + one-line rows |
| Gradient text on a title or a number | Solid `text-foreground` ink |
| A thick colored stripe on one side of a card, a hard offset shadow, or a hairline border with a wide shadow | A surface lightness shift or one hairline (DESIGN.md **Elevation**) |
| A pill badge or an icon tile stacked above a title, or numbers on sections that are not a sequence | The title alone. Numbers only for real steps. A `.ctx-label` eyebrow only where the house already uses one |
| A button that does not say what it does (“Submit”, “OK”, “Go”) | A verb and its object that name the result (“Add connection”, “Save token”) |
| Cute or corporate-filler copy (“Let’s get you set up!”, “Utilize…”, “Unlock the power of…”) | Plain, specific US English. ASD-STE100 at about 80% strength |
| A second icon library or custom SVG set | Tabler first; Lucide only if Tabler has no equivalent |

## Ceiling vs Operate

Large type, atmosphere, and signature moments belong on onboarding / marketing (or a [prototype](../../prototype/SKILL.md) exploration). They are tells when they leak onto settings, connectors, repositories, or chat.
