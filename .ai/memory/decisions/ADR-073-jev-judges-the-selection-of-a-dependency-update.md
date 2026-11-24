# ADR-073: Jev judges the selection of a dependency update, on evidence by used export

**Status:** Accepted | **Date:** 2026-11-25 | **Tags:** ci, testing, factory, models

## Context

On a dependency update, the selector of the merge gate and of `factory check` must keep the checks that can find a real break, and as few others as it can ([ADR-062](ADR-062-checks-run-before-merge-not-on-main.md)). Until this decision, a Claude Haiku call with no tools judged each group of tests and screenshots that import the changed package. It got the versions, the release notes or a cut diff of the package code (6,000 characters for each package), and a prompt that pushed to "yes". Its answer had no confidence, so no threshold could be tuned.

Two misses showed the cost:

- PR #1043 moved zod 4.6.5 to 4.6.7. The LLM stage dropped `scope-caps.test.ts`, and `main` failed two backend tests ([CTX-1568](https://linear.app/ctxpipe/issue/CTX-1568)).
- The labeled set of [CTX-1602](https://linear.app/ctxpipe/issue/CTX-1602) found that, on PR #1070 (`@tanstack/charts` 0.15 to 1.5), the selector kept the screenshots but dropped 46 play checks and 18 required story checks of the stories that throw with the new library. Recall on the regressions of that update was about 0.52 in each run.

The CTO, 2026-11-24: "We were using LLM because of the ability to use tools, otherwise we would use Jev to do the judgment with reliable confidence levels." Jev 1.14 (TypeSafe, through the OpenRouter Decisions API) answers a yes/no question with a probability. TypeSafe is a trusted provider ([ADR-070](ADR-070-model-calls-go-only-to-trusted-providers.md)), and the visual critic already uses Jev ([ADR-063](ADR-063-visual-critic-decides-with-jev.md)).

## Decision

1. **The factory gathers the evidence, with no model.** For each group, it finds the exports of the changed package that the group's own modules use (named imports, the default import, namespace members such as `z.union`). It gives the diff of exactly the declarations that those exports reach, types and code, also in changed packages of the dependency tree, with the lines of the importing modules that use them. The budget is large (up to 400,000 characters for each group), because Jev is cheap. A group whose used exports or diff the factory cannot find is kept (fail wide).
2. **Jev judges each group.** One yes/no question for each group, with its evidence. A group with a probability of 0.3 or more is kept. With no Jev answer (no key, an error, a timeout), the group is kept.
3. **The threshold comes from labeled cases, not from a guess.** `factory eval selection:deps` builds labels from facts: it runs the checks that the update reaches at the old and at the new package versions, with the same source tree. A check that passes at the old versions and fails at the new, or a screenshot whose pixels change, is a regression; a check that fails only at the old versions is `needs-new` and is not a regression. On the three labeled cases (#1043, #1070, #1092), 3 runs each, only thresholds 0.2 and 0.3 kept every regression in every run; 0.3 selected about a third fewer checks. Today's LLM judge, and the LLM judge with the new evidence, each missed a regression in at least one run.
4. **Run the eval again** for each change of the question, the evidence, the threshold or the model, as rule 7 of ADR-063 does for the visual critic. It runs on the host, never in CI.
5. **ctxpipe pins the factory release** that has this default (factory PR #681, `74259360`).

## Consequences

- A dependency update keeps more checks than before on some cases (for example about 400 to 480 on #1043, where the old judge kept about 65 and luckily caught both regressions), because Jev keeps or drops whole test groups by folder. Smaller test groups are a follow-up.
- The margin is thin: Jev gave the #1043 regression groups 0.34 to 0.39, and the #1070 chart play groups 0.46 to 0.51. Three labeled cases are few; more cases make the threshold safer. Each label build takes about 3 hours.
- The evidence (code of public npm packages and of the public ctxpipe repo) goes to TypeSafe through OpenRouter, with `data_collection: "deny"`.
- A host with no OpenRouter key keeps every judged group: it selects more than CI, never fewer. With an explicit `--llm-provider claude-cli`, the judge is off unless `--package-judge jev` is given, so a local run does not send code to OpenRouter by surprise.
