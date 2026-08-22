# Calibration: last-loop family vs type-compare crop

Image: `integrity-last-winner-compare.png` (Geist `ctx|` left, candidate right).

| Reviewer | Prompt | TYPE | CONSTRUCT |
| --- | --- | --- | --- |
| Sol (`gpt-5.6-sol-xhigh`) | “FINISHED? WOULD SHIP?” on the full labeled sheet | n/a (said ship) | n/a |
| Sol | scorecard TYPE/CONSTRUCT on compare crop | green | green |
| Claude Opus | same scorecard on compare crop | red | red |
| Composer | same scorecard on compare crop | red | red |
| Implementing agent | full scorecard | red | red |

Expected: RED / RED. Sol fails calibration. Discard Sol for integrity.
