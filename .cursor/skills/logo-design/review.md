# Review

The 2026-08-15 loop failed because **one** adversarial reviewer optimized **concept** (“kill hamburger,” “kill plus,” “longer stdout”) and each loop implemented the note. Ten loops of that is how you get a clever diagram with broken letters.

Worse: the same reviewer, asked “FINISHED? WOULD SHIP?” on that broken family, said **yes**. Concept-optimizing models will forgive homemade letters if the metaphor is coherent. They are not integrity reviewers.

Split the review. The [validate.md](validate.md) scorecard can veto concept.

## Two axes, two reviewers

Run in parallel only after every scorecard row is green. Do not let the concept reviewer see the designer’s essay.

### Craft reviewer

Attach the **full sheet** and the filled scorecard. No brief about pipes, inlets, or what to kill.

> Re-check each scorecard row from the pictures. Verdict: green or red. If red, name the row and stop. Do not suggest a new metaphor. Do not ask for another inlet. Do not answer “would you ship?”

### Concept reviewer

Attach only **green** candidates (compare + first-read crops, not a metaphor caption). Short brief: audience, protect-list, surfaces.

> Which green candidate better identifies ctxpipe for engineers? What to protect. At most three craft notes that would keep every scorecard row green. Ignore any change that would make letters, weight, or lockup worse.

If you use Sol, use it as the **concept** reviewer on green work — not as the only loop driver, not as an integrity judge, and not as a spec to implement line-by-line. Sol greened the known-broken fixture on both “would you ship?” and the scorecard `TYPE`/`CONSTRUCT` rows. It fails calibration.

## What a useful note looks like

Useful: “`t` crossbar is optically a plus at 20px — shorten the bar or add a foot.”
Useful: “Lockup gap is a full letter-width; close it until it matches the space inside `ctx`.”

Ignored: “Remove the third inlet.” “Extend stdout 30%.” “Make the pipe the object.” — unless the current drawing is already green and the change is drawn and re-gated.

## Loop rule

A loop is: draw → scorecard → (if green) concept → at most three craft edits → scorecard again.

If the scorecard is red, the loop is a redraw, not a metaphor variation. Cap concept-only loops at two. After that, stop and show the human the green set (or the type control).

When the human asked for N loops of M ideas: the **winner of loop k is the basis of loop k+1**. The next M ideas must inherit that winner. Abandoning a liked concept (echo, grit, a mark) for a fresh independent set is a process fail, not exploration.
