# Integrity sheet

The sheet is evidence for the [validate.md](validate.md) scorecard. It does not decide green/red by itself.

## Crops (required)

One HTML source, three PNGs via `render-integrity.mjs`:

1. **full** — labeled modules below. The implementing agent fills the scorecard from this.
2. **compare** (`?mode=compare`) — Geist `ctx|` vs candidate, dark + light, same cap height. Used for `TYPE`.
3. **first-read** (`?mode=first-read`) — candidate only, no title, no “two-inlet” copy. Used for `GLYPH`. Never send the full labeled sheet as a first-read.

Render with headless Chrome (`/usr/bin/google-chrome-stable` + `timeout 12`, unique `--user-data-dir`). The wrapper at `/usr/local/bin/google-chrome` hangs. Local Geist lives at `apps/ui/public/fonts/`; the sheet loads it via a relative `file:` URL plus `--virtual-time-budget` so the type control is actually Geist.

```bash
node .cursor/skills/logo-design/render-integrity.mjs \
  dark.svg light.svg mark64.svg out.png \
  "Integrity — name" mark16.svg mark-mono.svg
```

Writes `out.png`, `out-compare.png`, `out-first-read.png`.

## Full-sheet modules

1. **Type control** — Geist (or the product face) setting of the name at the same cap height as the candidate. Also show Geist Pixel Square if the candidate is competing with the onboarding `ctx|`.
2. **Candidate** — dark lockup, light lockup.
3. **Peer bench** — candidate lockup at 28px and 20px next to the type control at the same heights.
4. **Product chrome** — fake sidenav row at **20px** lockup height (matches `SideNavLogo`).
5. **Letter zoom** — wordmark at ~3× so `CONSTRUCT` is visible (`t` as two boxes, `x` as unjoined bars, missing overshoot).
6. **Size ladder** — mark at 64 / 32 / 16. 16px is a dedicated hint or it is omitted; never a smashed lockup. One-color beside them.
7. **Squint** — same dark lockup with `filter: blur(6px)`.
8. **First-read card** — candidate only (also exported as its own crop).

No concept captions on the art.

## Hard stops

One red scorecard row fails the candidate.

Do not keep a red mark because the metaphor is clever. Redraw, or fall back to the type control and add a smaller idea (color on `|`, spacing, a simple mark that is actually simple).
