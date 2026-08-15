# ctx| logo iteration journal

## Feedback-loop failure (2026-08-15)

The 10-loop Sol generate/rank path produced an interesting two-inlet / L-route metaphor and a **broken** lockup. Human: “looks quite broken.” The loop optimized captions (“kill hamburger,” “longer stdout”) and never gated finished-vs-broken.

Integrity re-test of the last-loop “winner”:

- Scorecard (implementing agent): **RED** on `TYPE`, `CONSTRUCT`, `NAV20`, `SQUINT`, `GLYPH`, `UNIT`, `DECK`. See `.cursor/skills/logo-design/fixtures/known-broken.scorecard.md`.
- Sol first-read of the labeled sheet, asked “FINISHED? WOULD SHIP?”: **yes** — this question is now banned.
- Sol on the type-compare crop + scorecard: still **green** on `TYPE`/`CONSTRUCT`.
- Claude Opus and Composer on the same crop + scorecard: both **red** (homemade `t` as two rectangles; letters lose to Geist).
- Rule: Sol is concept-only. Integrity is the implementing agent, optionally a reviewer that first fails the fixture.

Do **not** adopt `winner/` into production. Next design pass must follow `.cursor/skills/logo-design/` (calibrate → type control → ≤3 candidates → scorecard → concept only if green).

## Retracted ship decision (after 10 Sol loops)

**Was recommended, now calibration fixture:** Calibrated Reference lockup. Kept under `winner/` and copied to the skill `fixtures/` as known-broken.

Those “protect forever” metaphor rules were the loop talking to itself. Keep only the craft ones that still survive a scorecard (substrate-specific teal, dedicated 16px hint, no second pipe on the wordmark, no wordmark-as-favicon). Do not treat two-inlet / L-route as mandatory.

Production `apps/ui/public/ctx_.svg` is **not** replaced in this PR.

## Color

| Substrate | Inlets / letters | Route |
| --- | --- | --- |
| Dark UI | `#F4F4F5` | `#35D6C0` |
| Light / merch | `#09090B` | `#087F73` |
| One-color | same ink as the body | same ink, extra 16px junction clearance |

## Loop log

| Loop | Field | Sol winner | Note |
| --- | --- | --- | --- |
| 0 | Shipped pixel `ctx\|` | **Replace** | Gamey, fails 16–20px, no icon, white-only |
| 1 | Four foundations | **Routed Context** | Split mark from wordmark |
| 2 | Routed variations | **Asymmetric Route** | Long middle, short flanks, off-center out |
| 3 | Asymmetric variations | **Directional Bias** | Longer stdout, shorter flanks |
| 4 | Kill hamburger / plus | **Two-Inlet Route** | Drop the third bar |
| 5 | Optical craft | **Lower Junction** | Teal starts below the middle inlet |
| 6 | Lockup + crop | **Icon Master** | Square-first, no crop box in the identity |
| 7 | Icon system | **Wordmark Calibration** | Open c, narrower t, calmer x |
| 8 | Pixel / trim / type / color | **Optical Wordmark** | Kill Junction Trim; steal Pixel Lock + Color Authority |
| 9 | Near-final family | **Calibrated Reference** | Kill Compact and over-hinted Micro |
| 10 | Final optical | **Baseline Finish** | Steal 16px aperture, mono relief, light compensation |

## Files

- Loops: `loops/01` … `loops/10`
- Sheets: `renders/loop-01.png` … `loop-10.png`
- Recommended SVGs: `winner/`
