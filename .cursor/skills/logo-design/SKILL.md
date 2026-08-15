---
name: logo-design
description: Logo, wordmark, mark, lockup, favicon, or identity iteration. Use when designing or reviewing a brand mark, when a logo loop or Sol review is requested, or when a candidate looks broken and the feedback process itself needs fixing.
---

Design a **logo system** (mark + wordmark + lockups + sizes). Predictable process, not a pile of SVGs.

Public volume skills (N concepts × M files) optimize for metaphor. That is how the 2026-08-15 `ctx|` loop produced an interesting diagram and a **broken** mark. This skill inverts that: **integrity** first, **concept** second.

Read [validate.md](validate.md) before judging any candidate. Read [integrity.md](integrity.md) for the sheet. Read [craft.md](craft.md) before drawing custom letterforms. Read [review.md](review.md) before asking Sol (or any model) to rank options. Sources we adopted or left: [sources.md](sources.md).

## Process

### 1. Brief

Write 8–12 bullets: name, audience, job of the mark, must-work surfaces (dark UI, light, 20px sidenav, 16px favicon, merch), colors already in the product, what to protect from the current mark. Name the **architecture** you will try (wordmark / lockup / letterform-as-symbol) — one idea per candidate, not a diagram of the product.

Done when the brief names surfaces, a protect-list, and an architecture per direction.

### 2. Calibrate the gate

Run the [validate.md](validate.md) scorecard on [`fixtures/`](fixtures/CALIBRATION.md). It must come back **RED**. If a reviewer greens it, discard that reviewer.

Done when the fixture is RED and the reviewer (if any) is trusted or discarded.

### 3. Start from type

Set the wordmark in a **real face** already in the product (Geist, Geist Mono, Geist Pixel Square) or another finished typeface. Render `ctx|` (or the name) at the real sidenav height (**20px**). Design that size first; scale up.

Custom lettering is allowed only after this type lockup is a working control. Stacked rectangles are sketches, not letters.

Done when a type-control SVG exists and is on the integrity sheet.

### 4. Draw few candidates (tournament)

Default **three** directions; if the brief asks for four, draw **four**. They must be genuinely different architectures, each something you would put on a deck **today**.

If the human asked for repeated loops, this is a **tournament**, not a mood board:

- Loop 1 starts from the current mark (or the named concept they want refined).
- Each later loop’s four candidates are **descendants of the previous winner**. The winner is the only basis. Do not reset to four unrelated ideas.
- Show the basis on the four-up sheet so lineage is obvious.
- Optical 1px tweaks are craft notes inside a winner, not a loop of four.

Done when each candidate has dark + light lockup and a square mark, all from the same geometry.

### 5. Integrity gate

Render the three crops ([integrity.md](integrity.md)). Fill [scorecard.template.md](scorecard.template.md) per [validate.md](validate.md). A single red row **discards** the candidate. Do not send a failed mark to concept review. Do not “fix it in the next loop” by implementing a metaphor note.

Done when every surviving candidate is **green** on every scorecard row, or the set is empty and you redraw (or ship the type control).

### 6. Concept review

Only green candidates. Two axes, separate reviewers, per [review.md](review.md):

- **Craft** — re-check the scorecard, no brief
- **Concept** — does it identify ctxpipe for engineers?

A concept note that would break a scorecard row is ignored.

Done when one green candidate is the foundation, with at most three craft notes.

### 7. System, not a file

Ship lockup (dark/light), mark (64 + hinted 16), wordmark-only, one-color. Same geometry except the 16px hint.

Done when the family is on one sheet and still passes the scorecard.

## ctxpipe defaults

- Teal is the accent (`#40E0D0` / product teal scale). Dark UI first.
- The name lockup is `ctx|` (“context pipe”, Unix pipe). The idea can live in type, spacing, or a mark — not by forcing a second diagram beside broken letters.
- Product UI is sharp (`rounded-none`), zinc + teal, Geist. The mark should sit in that chrome without looking like a different product.
