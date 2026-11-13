# ADR-063: The visual critic decides with Jev only

**Status:** Accepted | **Date:** 2026-11-13 | **Tags:** visual-review, critics, factory, models

## Context

The visual critic (`critics.json`, entry `visual`) judges each changed baseline screenshot of a PR with `pnpm visual:review` ([CTX-1178](https://linear.app/ctxpipe/issue/CTX-1178)). Until this ADR, it sent each screenshot to a Sonnet-class LLM through OpenRouter, and it blocked on a `regression` with severity `major` or `blocker` (an owner decision). The bake-off of the critic ([CTX-1202](https://linear.app/ctxpipe/issue/CTX-1202), `packages/visual-review/evals/critic/`) compares the judges on labeled screenshot pairs. Its selection rule picks the cheapest arm with a recall of 0.9 or more and a precision of 0.7 or more on the hold-out set.

Bake-off run 43202777292 used the page-story dataset ([CTX-1249](https://linear.app/ctxpipe/issue/CTX-1249)). A judge panel (Opus 5.5, GPT-6.1-Sol, Gemini 4 Argon, plain 2-of-3 majority) labeled the real changes. The panel agreed with the known label on 105 of 119 synthetic cases. The 5-hour job limit stopped the run after the 27 hold-out cases (19 `regression`, 8 `intended`), with 1 run each.

Hold-out results:

| Arm | Recall | Precision | Unsure | Cost per story | p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `jev` (Jev 1.14) | 0.95 | 0.90 | 0.26 | $0.0004 | 2.1 s |
| `decision:baseten/elephant-1` | 0.79 | 0.88 | 0.26 | $0.0002 | 2.0 s |
| `decision:baseten/mammoth-1` | 0.79 | 0.88 | 0.22 | $0.0006 | 2.1 s |
| `llm:openai/gpt-6.1-sol` (a panel member) | 0.89 | 0.89 | 0.04 | $0.0097 | 27.6 s |
| `llm:anthropic/claude-opus-5.5` (a panel member) | 0.84 | 1.00 | 0.04 | unknown | 21.8 s |
| `llm:anthropic/claude-sonnet-5.5` (the old critic) | 0.79 | 1.00 | 0.15 | unknown | 19.9 s |
| `cascade:anthropic/claude-sonnet-5.5` (Jev, then Sonnet) | 0.74 | 1.00 | 0.26 | unknown | 16.5 s |
| `blazediff-local` (no model) | 0.05 | 1.00 | 0.44 | $0 | 150 s |

Jev also had a quality agreement of 0.65 and a region overlap of 0.36. Its highest cost for one call was $0.0008. The rule picks `jev`. The cascade lost recall because the LLM replaced correct `regression` verdicts of Jev.

The product owner decided on 2026-11-13: "Use Jev for this capability and just finish it, don't rerun others now. We want the visual diff critic functional now and we can improve the performance later."

## Decision

1. **Jev decides.** The `visual` entry runs `visual:review --judge jev`. Jev 1.14 (`typesafe/jev-1.14`, OpenRouter Decisions API, `judgeWithJev`) gives the final verdict of each changed screenshot. A new screenshot (no base image) goes to Jev too (`judgeNewWithJev`). No LLM explains or changes the verdict. `--judge model` (an LLM, with an optional `--filter jev`) and `--judge agent` stay for a person or a fork.
2. **Thresholds.** For a change, Jev answers one question for each area and each quality of the rubric (better, same or worse), one defect question, and one box question for the region. For a new screenshot, each question asks whether the screenshot breaks a rule.
   - A worse (or broken) area or quality with a probability of 0.5 or more is a `regression` with severity `major`. It blocks. An area needs the region of the box; without a box, the verdict is `unsure`.
   - A highest probability from 0.2 up to 0.5, or a question with no answer, is `unsure`.
   - Else the verdict is `intended` when the brief or the source diff explains the change, and `unsure` when nothing explains it.
   - An image pair in the tolerance of the visual check is `noise`, and a removed screenshot is `unsure`. Neither calls Jev.
3. **Each Jev regression blocks.** Before this ADR, the Jev adapter gave `major` only from a probability of 0.8, and `minor` below it. With that split, 15 of the 19 hold-out regressions blocked (block recall 0.79, with no false block). The selection rule measured each `regression` verdict, so the gate uses the same line: all 18 regressions that Jev found block, and 2 of the 8 intended changes block falsely (precision 0.90). An override with a reason (`code-review` skill) clears a false block.
4. **`unsure` stays a nit.** The factory makes `unsure` a nit for a person, as before. The code does not change this. A Jev reply that is not usable (a 400 or 413 answer, a reply out of the schema) is `unsure` with an error, and the command exits with code 2: the critic gives `ERROR`, never a pass.
5. **Spend.** The spend limit of the visual critic is $0.10 for each PR, across all runs (lead decision, 2026-11-13; it was $5). A change of a shared component (about 166 stories) costs about $0.07. A higher spend is unusual: the critic gives `ERROR`, and a person decides with `factory check --critic-limit-usd`. The limit is `LIMIT_USD` of the factory (`machines/cli/src/command.rs`, factory PR [#172](https://github.com/ctxpipe-ai/factory/pull/172)), and `.github/merge-gate.json` pins that release. There:
   - A path with no known cost counts at $0.0005 when the branch has no known cost yet (the Jev cost of a story, rounded up). Thus a first run can take about 200 paths.
   - The `{budgetUsd}` of a run is rounded down to $0.0001, not to a cent. A budget in whole cents would drop up to 25 Jev calls of the $0.10 limit.
   - `MAX_PATH_USD` stays $3. It only bounds a stored spend record, so that no writer can make the spend infinite, and it caps `{budgetUsd}`. With a $0.10 limit, a record above the limit already stops the critic, so a lower cap adds nothing.
   - In `visual:review --budget-usd`, a Jev reply with no `usage.cost` counts as $0.002 (above the highest Jev cost of the bake-off). An LLM reply with no cost still counts as $0.25. A missing cost never turns the budget off.
6. **Rule.** Run the bake-off again for each new decider model and for each change of the questions or the rubric, before the critic uses it.

## Consequences

- A visual review costs fractions of a cent for a normal PR, and it takes seconds.
- A blocking finding has an area, a region and a probability, but no written evidence: Jev gives no text. A person must find the defect in the image. To get a written verdict, run `pnpm visual:review --judge model` or `--judge agent` on your own machine.
- About one intended change in four can block falsely. Each false block needs an override with a reason.
- A quarter of the verdicts are `unsure` nits.

## Limits of the evidence

- 27 hold-out cases and 1 run. No consistency figure.
- The labels of the real changes come from a judge panel, not from a person. GPT-6.1-Sol and Opus are panel members, so the labels can favor them.
- Only page stories. Most changed baselines of a PR are component stories.
- No new-screenshot case got a result, so the judgment of a new screenshot by Jev has no measurement.
- 563 Anthropic calls returned no `usage.cost`. The spend of the run ($62.92) is an overestimate, and the Anthropic arms show no cost per story.

## Follow-ups

- [CTX-1255](https://linear.app/ctxpipe/issue/CTX-1255): Anthropic calls through OpenRouter give no `usage.cost` in the runner.
- [CTX-1256](https://linear.app/ctxpipe/issue/CTX-1256): an LLM explains a Jev block, and never overrides it.
- [CTX-1257](https://linear.app/ctxpipe/issue/CTX-1257): run the useful arms again on all 176 page cases with 3 runs.
- [CTX-1258](https://linear.app/ctxpipe/issue/CTX-1258): a dataset of component stories.

## Alternatives considered

- **The cascade (Jev filters, an LLM decides).** The LLM overrode correct Jev regressions, and the recall fell to 0.74. An LLM that only explains a Jev block is CTX-1256.
- **Keep the Jev severity split at 0.8.** A block recall of 0.79 is below the 0.9 of the selection rule that picked Jev.
- **GPT-6.1-Sol alone.** Recall 0.89, below the rule. It is a panel member, so its numbers can be too high. It costs about 25 times more and takes about 13 times longer.
- **Elephant or Mammoth.** Recall 0.79.
