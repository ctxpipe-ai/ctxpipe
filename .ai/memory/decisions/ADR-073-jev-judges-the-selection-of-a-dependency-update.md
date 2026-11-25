# ADR-073: Jev judges the selection of a dependency update, on evidence by used export

**Status:** Accepted | **Date:** 2026-11-25 | **Tags:** ci, testing, factory, models

## Context

On a dependency update, the selector of the merge gate and of `factory check` must keep the checks that can find a real break, and as few others as it can ([ADR-062](ADR-062-checks-run-before-merge-not-on-main.md)). Until this decision, a Claude Haiku call with no tools judged each group of tests and screenshots that import the changed package. It got the versions, the release notes or a cut diff of the package code (6,000 characters for each package), and a prompt that pushed to "yes". Its answer had no confidence, so no threshold could be tuned.

Two misses showed the cost:

- PR #1043 moved zod 4.6.5 to 4.6.7. The LLM stage dropped `scope-caps.test.ts`, and `main` failed two backend tests ([CTX-1568](https://linear.app/ctxpipe/issue/CTX-1568)).
- The labeled set of [CTX-1602](https://linear.app/ctxpipe/issue/CTX-1602) tested PR #1070 (`@tanstack/charts` 0.15 to 1.5). The new library makes the chart stories throw. The selector kept their screenshots. It dropped 61 to 63 of their play and required story checks in each run. Recall on the regressions of that update was about 0.52.

The CTO, 2026-11-24: "We were using LLM because of the ability to use tools, otherwise we would use Jev to do the judgment with reliable confidence levels." Jev 1.14 (TypeSafe, through the OpenRouter Decisions API) answers a yes/no question with a probability. TypeSafe is a trusted provider ([ADR-070](ADR-070-model-calls-go-only-to-trusted-providers.md)), and the visual critic already uses Jev ([ADR-063](ADR-063-visual-critic-decides-with-jev.md)).

## Decision

1. **The factory gathers the evidence, with no model.**
   - For each group, it finds the exports of the changed package that the group's own modules use: named imports, the default import, and namespace members such as `z.union`.
   - It gives the diff of the declarations that those exports reach, types and code. This includes changed packages of the dependency tree.
   - It adds the lines of the importing modules that use those exports.
   - The budget is large: up to 400,000 characters for each group. Jev is cheap.
   - When the factory cannot find the used exports or the diff, it keeps the group (fail wide).
2. **Jev judges each group.** One yes/no question for each group, with its evidence. A group with a probability of 0.3 or more is kept. With no Jev answer (no key, an error, a timeout), the group is kept.
3. **The threshold comes from labeled cases, not from a guess.**
   - `factory eval selection:deps` builds labels from facts. It runs the checks that the update reaches at the old and at the new package versions, with the same source tree.
   - A check that passes at the old versions and fails at the new is a regression. A screenshot whose pixels change is a regression too.
   - A check that fails only at the old versions is `needs-new`. It is not a regression.
   - The bake-off used three labeled cases (#1043, #1070, #1092), with 3 runs each. Only thresholds 0.2 and 0.3 kept every regression in every run. Threshold 0.3 selected about a third fewer checks.
   - The old LLM judge missed regressions in each run of #1070. The LLM judge with the new evidence missed one regression on #1043.
4. **Run the eval again** for each change of the question, the evidence, the threshold or the model, as rule 7 of ADR-063 does for the visual critic. It runs on the host, never in CI.
5. **ctxpipe pins a factory release** that has this default. `.github/merge-gate.json` holds the pin; each revision below names the factory PR of its release.

## Revision 2026-11-25: test groups by the nearest importing module

Jev judges the test checks of a changed package in groups by the nearest module that imports the package, as Jev does for the screenshot checks (factory PR #697, `2beb6e49`). ctxpipe pinned that release. Before, the test groups were by the folder of that module. A bake-off on four labeled cases (#1043, #1068, #1070, #1092; 3 runs each, 9 for threshold 0.4) applied the rule of decision 3:

- Thresholds 0.2 and 0.3 by module kept every regression in every run. Threshold 0.3 selected fewer checks.
- Threshold 0.4 by module missed `scope-caps.test.ts` of #1043 in 4 of 9 runs. Jev gave its group 0.37 to 0.45.
- On #1043, 0.3 by module selects 349 to 540 checks; 0.3 by folder selected 482 to 648. On the other cases the counts are about the same.

Most of the checks that stay on #1043 do not come from the grouping. A group of 149 backend tests imports `@modelcontextprotocol/sdk` through a type-only import that the evidence step cannot resolve, so the group stays (fail wide). 163 required stories get a probability of 0.30 to 0.31. The revision of 2026-11-26 gives better evidence for these groups.

## Revision 2026-11-26: evidence for type-only imports, CommonJS and new dependencies

The evidence step finds more of the code that a group uses (factory PR #728, `031f4b6c`):

- An `exports` condition falls through to the next condition when its file is missing, as TypeScript does. Thus a type-only import such as `import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"` now resolves.
- The walk follows a dependency that is new in the tree, a name with several versions, and an unchanged package that re-exports a changed one.
- The step reads CommonJS exports (`exports.x =`, `__exportStar`, `module.exports`).

Groups with no evidence went from 25 (202 checks) to 3 (3 checks) on #1043, and from 94 to 29 on #1068. The 29 groups that stay import a package whose entry is one UMD bundle, so they stay kept (fail wide).

A bake-off on five labeled cases (#1041, #1043, #1068, #1070, #1092; 3 runs each, threshold 0.3) kept every regression in every run. On #1043, the release before this revision selected 395–589 checks in this bake-off, and this release selects 288–456 checks. (The range of the release before differs from the 349–540 of the revision of 2026-11-25 because Jev answers differ from run to run near the threshold.)

## Consequences

- Some dependency updates keep more checks than before. On #1043, Jev keeps about 290 to 460 checks; the old judge kept about 65. The old judge found both regressions of that case, but by chance.
- The probabilities of the regression groups are near the threshold. With the test groups by module, Jev gave the group of `scope-caps.test.ts` (#1043) 0.37 to 0.45, and the #1070 chart play groups 0.46 to 0.51. Five labeled cases are few. More cases make the threshold safer. Each label build takes about 3 hours.
- The evidence (code of public npm packages and of the public ctxpipe repo) goes to TypeSafe through OpenRouter, with `data_collection: "deny"`.
- A host with no OpenRouter key keeps every judged group. It selects more than CI, never fewer.
- With an explicit `--llm-provider claude-cli`, the judge is off unless the operator gives `--package-judge jev`. Thus a local run sends no code to OpenRouter without that option.
