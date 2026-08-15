# ctx| logo iteration journal

## Ship decision (after 10 Sol loops)

**Recommended family:** Calibrated Reference lockup with baseline finish, plus scoped optical variants.

Protect forever:

- Asymmetric **two-inlet / one-exit** silhouette
- Teal **only** on the down-and-out route
- Open lowercase `ctx` (no second pipe)
- Square-first icon master
- Substrate-specific teal: `#35D6C0` on dark, `#087F73` on light, **no teal in mono**
- Dedicated 16px hint (do not scale the 64px master)

Never again:

- Pixel wordmark as the identity
- Second pipe on the wordmark
- Three equal inlets (hamburger)
- Centered plus-sign junction
- One teal for every substrate
- Wordmark-as-favicon

Production `apps/ui/public/ctx_.svg` is **not** replaced in this PR. Adopt from `winner/`.

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
