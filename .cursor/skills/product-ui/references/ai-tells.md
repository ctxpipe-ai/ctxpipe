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
| Cute or corporate-filler copy (“Let’s get you set up!”, “Utilize…”, “Unlock the power of…”) | Plain, specific UK English |
| A second icon library or custom SVG set | Tabler first; Lucide only if Tabler has no equivalent |

## Ceiling vs Operate

Large type, atmosphere, and signature moments belong on onboarding / marketing (or a [prototype](../../prototype/SKILL.md) exploration). They are tells when they leak onto settings, connectors, repositories, or chat.
