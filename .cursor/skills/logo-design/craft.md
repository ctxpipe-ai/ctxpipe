# Craft

Execution is what makes a concept look like a logo. Sources: Ian Paget / Logo Geek ([fundamentals](https://logogeek.uk/logo-design/ultimate-guide), [optical corrections](https://logogeek.uk/logo-design/optical-corrections/)); Tobias Frere-Jones, *Typeface Mechanics* (overshoot); Sagi Haviv — a logo is the period at the end of the sentence, not the sentence.

## What a logo is

A logo **identifies**. It does not explain the product. If the mark needs a caption (“stdin bars dock into a teal pipe”), it is a diagram.

A good mark is simple, versatile, distinctive, legible at the sizes it will actually appear, and **well executed**. Versatile means a **system**: dark / light / one-color, lockup / mark / wordmark, and a small-size drawing — not one SVG stretched everywhere.

Pick an **architecture** and stay in it: wordmark (Stripe), lockup (Slack), letterform-as-symbol (the `|` or a monogram), or a simple geometric mark derived from the letters. Do not stack a second diagram beside the name unless that mark survives the scorecard on its own.

Restraint: silhouette (squint), one-color, two-second, sketchable. Every extra cut must earn its place at **20px**. Design the sidenav and 16px mark first, then scale up.

## Optical correction

Math-even looks wrong. Correct by eye so it *looks* even.

- **Overshoot** — curves (`c`, `o`) and points (`x`, `v`) extend slightly past the flat cap-height / baseline of `t` / `x` stems. A circle the same height as a square looks smaller.
- **Kerning** — equalize the *volume* of space between pairs (`c–t`, `t–x`), not the measured gap. Blur the wordmark 4–6px; merged or gappy pairs are the error. Flip the wordmark horizontally; spacing errors survive the flip, reading familiarity does not.
- **Optical center** — align on visual mass, not the bounding box. A mark with a hanging L sits higher than its box suggests.
- **Irradiation** — white-on-black looks heavier than the same paths black-on-white. Light and dark drawings are separate optical tunings of one geometry, not a fill swap.
- **Horizontal stems** — slightly thinner than verticals of the same “weight,” or they look heavier.

Grids are guides. If the grid and the eye disagree, the eye wins.

## Type

Prefer a real face. Geist / Geist Mono / Geist Pixel Square are already in `apps/ui`. A finished `ctx|` in Geist Pixel Square (onboarding already types this) is a stronger wordmark than improvised geometry.

If you custom-draw letters:

- Draw an alphabet, not three glyphs that do not share a system.
- `c` is lowercase (x-height, wide aperture) or honestly cap — not a cap-height “c” pretending.
- `t` has an ascender and a crossbar that is not a plus.
- `x` has open counters and a thinned crossing.
- Convert to outlines only after the face is decided; keep a live-text control.

## Small sizes

Hairlines die. Counters close. Prefer mass over outline. The 16px mark is a **hinted drawing** of the same idea (fewer cuts, heavier stems), not `transform: scale`.

ctxpipe sidenav lockup is **20px** tall (`SideNavLogo`). That is the primary digital size. Design there first, then up.

## System

| Asset | Role |
| --- | --- |
| Lockup dark / light | Product chrome, site, decks |
| Wordmark only | When the mark would duplicate a pipe already in type |
| Mark 64 | App icon, OG, avatar |
| Mark 16 | Favicon / tab — hinted |
| One-color | Merch, engraving, stamp |

Clear space and a minimum size belong with the family. Color: teal is the accent, not a coat of paint on every stroke.
