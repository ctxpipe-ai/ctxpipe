# Integrity scorecard

- Candidate: shipped `apps/ui/public/ctx_.svg`
- Sheet: `integrity-current.png` + compare + first-read
- Reviewer: implementing agent
- Calibration fixture this session: RED (last-loop family)

| ID | Verdict | Evidence (one line, from the picture) |
| --- | --- | --- |
| TYPE | red | Geist `ctx\|` is a face; the pixel-grid `ctx` is a coarser construction and loses at the same cap height |
| CONSTRUCT | green | `c`/`t`/`x` share one pixel grid and weight |
| LIGHT | red | Letters stay white; on the light cell only the teal pipe survives |
| NAV20 | red | At 20px the pixel `t`/`x` turn into a few squares next to a crisp control |
| SQUINT | green | One white word + a taller teal stem |
| GLYPH | green | First-read is `ctx\|` (a terminal wordmark), not an accidental plus or equals |
| UNIT | green | Letters and pipe are one lockup |
| INK | green | Mono is the same drawing in one ink |
| DECK | red | White-only asset plus gamey pixels would not sit on a light deck |

**Result:** RED

Shipped mark is a coherent `ctx|` idea and a real first-read, but it is not a green family (light + small size + type quality). It is the protect-list baseline, not a pass.
