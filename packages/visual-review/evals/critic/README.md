# Bake-off of the visual critic

The bake-off compares critic models on a fixed set of labeled screenshot pairs ([CTX-1178](https://linear.app/ctxpipe/issue/CTX-1178), Phase 4). This folder holds the builder of that set, the runner, and the report.

## Cases

| Kind | Count | How the builder makes it | Label |
| --- | --- | --- | --- |
| `intended` | 60 | A real commit that changed a story file, a component beside a story file, or a module that a story file imports directly. The builder renders the story at the first parent and at the commit. The brief is the commit message, with the pull request title when the GitHub CLI finds it. The old name of the required story set becomes `required` in a brief. | `intended` (the owner can change it) |
| `regression` | 8 × 10 | One CSS or DOM change on one element of a clean render, before the screenshot. The source does not change. The classes are in `mutations.ts`. | `regression`, with the class and the known region |
| `noise` | 2 × 10 | A transform below one pixel, or a thin text stroke, on the whole story. | `noise` |
| `mixed` | 20 | A real commit, with a synthetic regression in the after image. A mixed case can use the pair of an intended case; then the two cases differ only by the regression. | `regression`, with the class and the known region |

The builder keeps only the pairs that differ by more than the tolerance of the visual check (10 pixels). A mixed case must also show both parts: the real change and the regression. The stories in `scripts/ci/visual-unstable-stories.json` (desktop) give no case. A run that gives fewer than 150 cases stops and does not change the manifest. The known region is the box of the changed element before and after the change, 2 pixels wider on each side.

## Files

- `cases.json`: the case manifest. It is in git. Its schema is `cases.schema.json`, from `cases.ts`.
- `build.ts`: the builder (`pnpm visual:bakeoff:build`).
- `run.ts`: the runner (`pnpm visual:bakeoff:run`).
- `report.ts`: the metrics, the report tables and the selection rule.
- `capture.ts`: the capture step. It runs in the pinned capture container (`scripts/ci/visual-container.json`) with the play runner and the pins of the visual check.
- `mutations.ts`: the synthetic changes and their known regions.

The images are not in git. Each image path of the manifest is relative to the output folder. Later, the factory puts the images into a Langfuse dataset.

## Build the cases

Run the command from the repository root. Docker must run.

```sh
pnpm visual:bakeoff:build [--seed 1] [--until <commit>] [--out .ci-results/visual-bakeoff]
```

The command does these steps:

1. It reads the first-parent history of `apps/ui/src` up to `--until`, and selects the newest 60 commits that change a story.
2. It builds Storybook for each commit and each first parent, from a `git archive` export in a temporary folder. Commits with the same `apps/ui`, `packages` and lockfile trees share one build. Each build stays in `<out>/builds/`, so a second run builds only the missing ones.
3. It captures all screenshots two times, each time in 4 capture containers at the same time. A screenshot that is not the same in the two rounds gives no case. Each candidate has its own seeded rank, so a story that is steady in one run and not in another changes only its own case.
4. It compares each pair with the compare engine of the package, selects the cases with the seed, writes the images to `<out>/cases/<id>/`, and writes `cases.json`.

The same seed and the same `--until` commit give the same cases. The `--until` commit must be in the history of `origin/main`, because the builder installs and builds each commit on the host. The output folder must be in the repository, because the capture container mounts only the repository.

A new build writes a new `cases.json`. It does not keep the labels that the owner changed or the taste picks. Copy them to the new manifest.

## Run the bake-off

Run the command from the repository root. The paid arms use `MODEL_PROVIDER_API_KEY` (and `MODEL_PROVIDER_URL`), so a fork can run the bake-off with its own key.

```sh
pnpm visual:bakeoff:run --arms <list> [--images .ci-results/visual-bakeoff] [--out .ci-results/visual-bakeoff/report] [--runs 3] [--max-cost 100] [--max-minutes <n>] [--concurrency 4] [--seed <n>] [--blazediff-agent <dir>]
```

An arm is a judge with its settings. `<model>` is an OpenRouter id.

| Arm | Judge |
| --- | --- |
| `llm:<model>` | The critic prompt: describe each side, then compare. |
| `llm-one-step:<model>` | The critic prompt with a one-step comparison. |
| `llm-no-facts:<model>` | The critic prompt without the interpreter facts: no change type and no confidence for a region, as when the interpreter is not available. |
| `jev` | Jev alone (`typesafe/jev-1.14`). |
| `decision:<model>` | Another decision model of the OpenRouter Decisions API, with the questions of the Jev adapter. |
| `cascade:<model>` | Jev, then `<model>` when Jev does not accept the change (the `--filter jev` of `pnpm visual:review`). |
| `blazediff-local` | The local judge of BlazeDiff: Moondream describes each region, and Qwen classifies the change. It runs on the host at no cost. It needs `--blazediff-agent <dir>`: a folder where `npm install --prefix <dir> @blazediff/agent@0.13.2 @huggingface/transformers@4.3.2` ran. These packages are about 460 MB, so they are not dependencies of the repository. |

The runner compares each pair with the compare engine of the package and gives each arm the same story input as `pnpm visual:review`. As in the critic, a case whose regions are all `rendering-noise` is `noise` with no call. An `llm-no-facts` arm has no change types, so this step does not apply to it. The case manifest has no scope, so each case is judged as a part of the UI, and the page-only qualities are not judged.

The runner holds out 30% of the cases of each kind. A hash of the seed (default: the seed of the manifest) and the case id selects them, so the same seed gives the same set. The runner does all runs of the hold-out cases first, then the other cases. A failed call gets one retry. If the retry fails, the verdict is `unsure` with an error.

Two limits stop the run. When the known cost of the run reaches `--max-cost`, no paid call starts. After `--max-minutes`, no call starts. The calls that already started finish, so the spend can go above the cap by the cost of those calls. A call without `usage.cost` does not count; the report gives the number of such calls. When a limit stops the run, the report counts only the cases and runs that every arm judged.

The runner writes `results.json` (each verdict of each arm, case and run) and `report.md` in `--out`, and prints the report.

## Report

The report has a table for the hold-out set and a table for the other cases. Each table has one row for each arm:

- **Recall**: the share of the verdicts on `regression` cases that are `regression`. This is the main metric.
- **Precision**: the share of the `regression` verdicts that are on `regression` cases.
- **Unsure**: the share of the verdicts that are `unsure`. **Errors**: the number of verdicts with an error.
- **Severity agreement** and **Quality agreement**: the cases have no severity or quality labels. Thus, for each case and run, the report finds the most common severity of all arms, and the most common delta of each quality of the arms that rate it. The agreement is the share of the verdicts of the arm with the same value. Quality agreement is the mean over the qualities. A table at the end gives each quality.
- **Region overlap**: for each `regression` verdict on a case with a known region, the best intersection over union of a finding region and the known region (0 when the verdict has no finding). The value is the mean.
- **Consistency**: the share of the cases on which all runs of the arm give the same verdict.
- **Cost per story**: the mean of `usage.cost`. It is `unknown` when a call gave no cost.
- **p50 ms** and **p95 ms**: the latency of the judge, as the adapters measure it.
- **Taste win rate**: from the `taste` picks in `cases.json`. A pick is a blind pairwise choice of the owner: a case, two arms, and the winner or `tie`. A win counts 1 and a tie counts 0.5, over the picks of the arm. The cells say "no labels yet" when the manifest has no picks.

**Selection rule:** of the arms with recall ≥ 0.9 and precision ≥ 0.7 on the hold-out set, the report selects the cheapest. Arms with the same cost per story (to $0.0001) tie, and the taste win rate breaks the tie. An arm with an unknown cost comes after the others.

## The workflow

`.github/workflows/visual-bakeoff.yaml` runs the bake-off by hand in the `workbench` environment, with its spend-capped `MODEL_PROVIDER_API_KEY`. It downloads the case images as a `.tar.gz` of the builder output (`images_url`, checked with `images_sha256`). It installs the local judge of BlazeDiff in its own folder, and runs the arms with `--max-cost` (default 100) and `--max-minutes 300`. The job summary shows the report, and the artifact `visual-bakeoff-report` holds `report.md` and `results.json`.

The default arms are the models of the plan in the three prompt arms, Jev, the cascade with Sonnet, and the local judge. A full run of all of them costs more than $100. The hold-out cases go first, so a run that the cap stops still has the cases of the selection rule. To spend less, give fewer arms or fewer runs.
