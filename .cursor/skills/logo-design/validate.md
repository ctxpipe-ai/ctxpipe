# Validate — does this feel broken?

Integrity is a **scorecard**, not a taste poll. The 2026-08-15 loop asked Sol “FINISHED? WOULD SHIP?” on the last-loop family. Sol said **yes**. A human looking at the same art next to Geist `ctx|` said it looked broken. That question is banned.

## Calibration (every session, before a new candidate)

Run the scorecard on the fixture in [`fixtures/`](fixtures/CALIBRATION.md) (last-loop recommended lockup). Expected: **RED** on `TYPE` and `CONSTRUCT`.

If a reviewer greens the fixture, **discard that reviewer’s integrity verdict** for the rest of the session. The implementing agent fills the scorecard from the sheet. Do not proceed with a reviewer who cannot fail known-broken work.

Proven on this fixture (2026-08-15): Sol greened `TYPE`/`CONSTRUCT` (and earlier said “would ship”). Claude Opus and Composer marked both rows **red**. Do not use Sol for integrity, even with this scorecard.

Done when the fixture is on record as RED and the reviewer (if any) either agrees or is discarded.

## Scorecard

Copy [`scorecard.template.md`](scorecard.template.md). Answer from the **pictures**, not the brief. One red row fails the candidate.

| ID | Look at | Green | Red |
| --- | --- | --- | --- |
| **TYPE** | Type-compare crop, same cap height | Candidate letters hold up next to Geist | Control looks like type; candidate looks traced / stacked / homemade |
| **CONSTRUCT** | Wordmark SVG + letter zoom | Live type, outlined type, or one custom system with shared weight, overshoot, open counters | `c`/`t`/`x` are stacked boxes, unjoined bars, or three unrelated drawings |
| **LIGHT** | Light lockup on white | Every letter stroke is visible | White-on-white, or only the teal survives |
| **NAV20** | 20px sidenav row | You can name `c`, `t`, and `x` without a caption | Mush, plus-sign `t`, or a cluster where `x` was |
| **SQUINT** | Blur 6px | One mark + one word | Scatter of bars |
| **GLYPH** | First-read crop only (no sheet chrome) | Reads as a logo / word / simple mark | Accidental `+`, `=`, `≡`, hamburger, USB, flag, medical plus, “unfinished icon” |
| **UNIT** | Dark lockup | One object; gap from **visible** bounds | Icon pasted beside type; empty crop-box gap |
| **INK** | One-color mark | Still a logo in one ink | The idea needed teal to exist |
| **DECK** | Full sheet next to product UI in your head | Could sit on a deck tomorrow | Looks like a wireframe of a logo |

Banned integrity questions: “Would you ship?”, “FINISHED?: yes/no”, “Is the geometry intentional?”.

## Who judges

1. **Primary:** the implementing agent, looking at the three crops, filling every row.
2. **Optional second:** a different model, given **only** the type-compare crop + `TYPE` / `CONSTRUCT` rows. No brief. No “would ship.”
3. Sol (or any concept-optimizing model) is **not** an integrity reviewer. Use it only after every row is green, per [review.md](review.md).

## Crops (required)

`render-integrity.mjs` writes three PNGs:

- **full** — labeled sheet (you fill the scorecard from this)
- **compare** — Geist `ctx|` vs candidate only (TYPE)
- **first-read** — candidate on a field, no title (GLYPH)

A first-read of the **full labeled sheet** is contaminated. Do not use it for GLYPH.

## Mechanical assists (not a substitute)

- Light lockup whose letter fills are `#fff` / `#F4F4F5` / `white` on a white stage → `LIGHT` red.
- Wordmark whose `t`/`x` are only `<rect>` (no shared stroke, no overshoot) → `CONSTRUCT` red.
- The type-compare **photo** still wins if a script is green and the eye is not.
