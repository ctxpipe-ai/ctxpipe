# ADR-063: The visual critic decides with Jev only

**Status:** Accepted | **Date:** 2026-11-13 | **Tags:** visual-review, critics, factory, models

## Context

The visual critic (`critics.json`, entry `visual`) judges each changed baseline screenshot of a PR with `pnpm visual:review` ([CTX-1178](https://linear.app/ctxpipe/issue/CTX-1178)). Until this ADR, it sent each screenshot to a Sonnet-class LLM through OpenRouter, and it blocked on a `regression` with severity `major` or `blocker` (an owner decision). The bake-off of the critic ([CTX-1202](https://linear.app/ctxpipe/issue/CTX-1202), `packages/visual-review/evals/critic/`) compares the judges on labeled screenshot pairs. Its selection rule picks the cheapest arm with a recall of 0.9 or more and a precision of 0.7 or more on the hold-out set.

Bake-off run 43202777292 used the page-story dataset ([CTX-1249](https://linear.app/ctxpipe/issue/CTX-1249)). A judge panel (Opus 5.5, GPT-6.1-Sol, Gemini 4 Argon, plain 2-of-3 majority) labeled the real changes. The panel agreed with the known label on 105 of 119 synthetic cases. The 5-hour job limit stopped the run before each arm judged each hold-out case. The table below uses the 27 hold-out cases (19 `regression`, 8 `intended`) that every arm judged, with 1 run each. Correction: the hold-out set has 47 cases. On all 47 cases, a later Jev-only run (43360812931) gave the old rubric a recall of 0.79, a precision of 0.90 and an unsure rate of 0.38 (see rule 8).

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
   - A worse (or broken) area or quality with a probability of 0.5 or more is a `regression` with severity `minor`. An area needs the region of the box; without a box, the verdict is `unsure`.
   - A highest probability from 0.2 up to 0.5, or a question with no answer, is `unsure`.
   - Else the verdict is `intended` when the brief or the source diff explains the change, and `unsure` when nothing explains it.
   - An image pair in the tolerance of the visual check is `noise`, and a removed screenshot is `unsure`. Neither calls Jev.
3. **A Jev result is feedback, never a block** (owner decision, 2026-11-13). Each Jev `regression` has severity `minor`, so the factory makes it a nit, and the critic passes. The visual critic is a feedback loop for the implementing agent, not a gate that needs an override. On the 27 cases that every arm judged, Jev with the first rubric found 18 of the 19 regressions (recall 0.95), but its precision was 0.90: it also flagged 2 of the 8 intended changes. With the rubric of rule 8, the precision on all 47 hold-out cases is 0.83. A block on each of those needs an override; feedback does not.
   - In `--images` mode, `visual:review --judge jev` copies the `before`, `after` and `diff` images of each suspected regression (only `after` for a new screenshot) to a new private folder of the system temporary folder, which the command keeps. The summary of the verdict names the area or quality, the probability of Jev, the region when Jev placed one, and the paths of these copies. The factory shows the summary in the finding.
   - The agent looks at the images of each suspected regression. It fixes the defect, or it says in the PR description why the change is intended.
   - The shared store keeps only the verdict word and the severity. A reused verdict has no image paths. Then the agent compares the base image (`git show <merge base>:<path>`) with the head image in its checkout.
   - A screenshot of a group that Jev did not judge gets the summary of the judged screenshot, and its own images.
4. **`unsure` stays a nit.** The factory makes `unsure` a nit, as before. The code does not change this. **The critic passes unless the run fails.** A Jev reply that is not usable (a 400 or 413 answer, a reply out of the schema), a missing key, or a spend stop gives exit code 2, and the critic gives `ERROR`, never a pass.
5. **Spend.** The spend limit of the visual critic is $0.10 for each PR, across all runs (lead decision, 2026-11-13; it was $5). A change of a shared component (about 166 stories) costs about $0.07. A higher spend is unusual: the critic gives `ERROR`, and a person decides with `factory check --critic-limit-usd`. The limit is `LIMIT_USD` of the factory (`machines/cli/src/command.rs`, factory PR [#172](https://github.com/ctxpipe-ai/factory/pull/172)), and `.github/merge-gate.json` pins that release. There:
   - A path with no known cost counts at $0.0005 when the branch has no known cost yet (the Jev cost of a story, rounded up). Thus a first run can take about 200 paths.
   - The `{budgetUsd}` of a run is rounded down to $0.0001, not to a cent. A budget in whole cents would drop up to 25 Jev calls of the $0.10 limit.
   - `MAX_PATH_USD` stays $3. It only bounds a stored spend record, so that no writer can make the spend infinite, and it caps `{budgetUsd}`. With a $0.10 limit, a record above the limit already stops the critic, so a lower cap adds nothing.
   - In `visual:review --budget-usd`, a Jev reply with no `usage.cost` counts as $0.002 (above the highest Jev cost of the bake-off). An LLM reply with no cost still counts as $0.25. A missing cost never turns the budget off.
6. **Data receiver.** Each changed screenshot, the brief and the source diff now go to TypeSafe (Jev) through the alpha OpenRouter endpoint `/api/alpha/decisions`. Before, they went to Anthropic, and only an opt-in `--filter jev` reached TypeSafe. The request sets `provider.data_collection: "deny"`, but no one has confirmed that OpenRouter applies it on the alpha endpoint, or the retention terms of TypeSafe. The screenshots are Storybook stories with mock data, and the repository is public.
7. **Rule.** Run the bake-off again for each new decider model and for each change of the questions or the rubric, before the critic uses it.
8. **Rubric update (2026-11-13).** The rubric has sharper definitions and one new area, `broken-content`, so that each Jev question names defects that a screenshot shows and ties them to our design docs. The new rules come from two design guides that the product owner recommended, [frontend-design](https://agenticskills.io/skills/frontend-design) and [Impeccable](https://impeccable.style/), with only the rules that agree with `apps/ui/DESIGN.md`. A Jev-only bake-off on all 47 hold-out cases (panel labels, 1 run) measured the change (rule 7). Before (run 43360812931): recall 0.79, precision 0.90, unsure 0.38, $0.0004 per story. After (run 43360825713): recall 0.91, precision 0.83, unsure 0.23, $0.0005 per story. Only the new rubric passes the selection rule (recall 0.9 or more, precision 0.7 or more). The lower precision is acceptable, because a Jev result is feedback that never blocks (rule 3).

## Consequences

- A visual review costs fractions of a cent for a normal PR, and it takes seconds.
- A visual finding has an area, a region, a probability and the images, but no written evidence: Jev gives no text. The agent must find the defect in the images. To get a written verdict, run `pnpm visual:review --judge model` or `--judge agent` on your own machine.
- No visual finding stops a merge. A real regression that the agent ignores can merge. The agent must answer each suspected regression with a fix or a reason in the PR.
- With the first rubric (27 cases), about one intended change in four got a feedback finding that the agent answers with a reason, and a quarter of the verdicts were `unsure` nits. With the rubric of rule 8 (47 cases), the precision is 0.83 and 0.23 of the verdicts are `unsure`.

## Limits of the evidence

- The arm table uses 27 of the 47 hold-out cases and 1 run. The rubric comparison of rule 8 uses all 47 cases and 1 run. No consistency figure.
- The labels of the real changes come from a judge panel, not from a person. GPT-6.1-Sol and Opus are panel members, so the labels can favor them.
- Only page stories. Most changed baselines of a PR are component stories.
- No new-screenshot case got a result, so the judgment of a new screenshot by Jev has no measurement.
- 563 Anthropic calls returned no `usage.cost`. The spend of the run ($62.92) is an overestimate, and the Anthropic arms show no cost per story.

## Follow-ups

- [CTX-1255](https://linear.app/ctxpipe/issue/CTX-1255): Anthropic calls through OpenRouter give no `usage.cost` in the runner.
- [CTX-1256](https://linear.app/ctxpipe/issue/CTX-1256): an LLM explains a suspected Jev regression, and never overrides it.
- [CTX-1257](https://linear.app/ctxpipe/issue/CTX-1257): run the useful arms again on all 176 page cases with 3 runs.
- [CTX-1258](https://linear.app/ctxpipe/issue/CTX-1258): a dataset of component stories.

## Alternatives considered

- **The cascade (Jev filters, an LLM decides).** The LLM overrode correct Jev regressions, and the recall fell to 0.74. An LLM that only explains a Jev block is CTX-1256.
- **Each Jev regression blocks (`major`).** This was the first version of this ADR. It matched the measured 0.95 recall, but 2 of the 8 intended changes would block and need an override. The owner chose feedback over a gate.
- **Keep the Jev severity split at 0.8** (`major` from 0.8 blocks, `minor` below is a nit). A block recall of 0.79, and the same false-block problem.
- **GPT-6.1-Sol alone.** Recall 0.89, below the rule. It is a panel member, so its numbers can be too high. It costs about 25 times more and takes about 13 times longer.
- **Elephant or Mammoth.** Recall 0.79.
