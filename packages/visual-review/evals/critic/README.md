# Bake-off of the visual critic

The bake-off compares critic models on a fixed set of labeled screenshot pairs ([CTX-1178](https://linear.app/ctxpipe/issue/CTX-1178), Phase 4). This folder holds the builder of that set, the judge panel that labels the real changes, the runner, and the report. The runner sends a `new` case to the judge of a new screenshot, not to the judge of a change ([CTX-1243](https://linear.app/ctxpipe/issue/CTX-1243)).

## Cases

All cases are page stories: the stories with the `page` tag, at the desktop viewport (1440 × 900) and at the mobile viewport (390 × 844) of the visual check ([CTX-1249](https://linear.app/ctxpipe/issue/CTX-1249)). A page shows a change in its context, so a judge can tell if the change is an improvement. Component stories become a second set later.

| Kind | Count | How the builder makes it | Label |
| --- | --- | --- | --- |
| `intended` | up to 60 | A real commit that changed `apps/ui/src`. The builder renders each page story at the first parent and at the commit. The brief is the commit message, with the pull request title when the GitHub CLI finds it. The old name of the required story set becomes `required` in a brief. | The label of the judge panel: `intended` for `improvement`, `regression` for `regression`, `noise` for `no-change`. `unsure` until the panel agrees (then the case does not run), or the label of the owner |
| `regression` | 8 × 10 | One CSS or DOM change on one element of a clean render, before the screenshot. The source does not change. The classes are in `mutations.ts`. | `regression`, with the class and the known region |
| `noise` | 2 × 10 | A transform below one pixel, or a thin text stroke, on the whole story. | `noise` |
| `mixed` | 20 | A real commit, with a synthetic regression in the after image. A mixed case can use the pair of an intended case; then the two cases differ only by the regression. | `regression`, with the class and the known region |
| `new` | up to 10 + 10 | A story that a real commit added: the first parent does not have it. The case has only the after image and no diff (`diffPixels` is null), because the critic judges a new screenshot on its own ([CTX-1224](https://linear.app/ctxpipe/issue/CTX-1224)). The brief is the commit message. Up to 10 cases are the clean render. Up to 10 more have a synthetic regression of `class` in the render. | `intended` for the clean render; `regression`, with the class and the known region, for the broken one |

The builder keeps only the pairs that differ by more than the tolerance of the visual check (10 pixels). A broken new case must differ from its clean render by more than that tolerance. A mixed case must also show both parts: the real change and the regression. The screenshots in `scripts/ci/visual-unstable-stories.json` give no case. A run that gives fewer than 100 cases stops and does not change the manifest.

**Visibility rule.** A real change (an `intended` case, and the real part of a `mixed` case) must be clearly visible. The BlazeDiff interpreter labels each changed region. The changed pixels of the regions that it does not label `rendering-noise` must cover at least 0.2% of the image: 2,592 pixels at the desktop viewport, 659 at the mobile one. The first owner queue had 60 real changes, and most of them were noise for a judge. 52 were component stories in an empty frame. 13 changed fewer than 200 pixels (a status dot of 12 × 12 pixels, a small icon). Many changed one line of text. Two commits gave 29 of the 60 cases, and one diff came again on many stories. The rule drops 26 of those 60 cases.

**One case for each change.** A change to a shared part, such as the sidebar, shows the same diff on many pages. The builder keeps one real change for each commit, viewport and region signature (the change types, positions and sizes of the regions), and at most 6 real changes of each commit. Two stories or two commits can also give the same pair of images (a page in the same state, or a focus ring that one build shows and the next does not): each kind keeps one case of each pair. The known region is the box of the changed element before and after the change, 2 pixels wider on each side.

## Files

- `cases.json`: the case manifest. It is in git. Its schema is `cases.schema.json`, from `cases.ts`.
- `build.ts`: the builder (`pnpm visual:bakeoff:build`).
- `panel.ts`: the judge panel that labels the real changes (`node packages/visual-review/evals/critic/panel.ts`).
- `run.ts`: the runner (`pnpm visual:bakeoff:run`).
- `spend.ts`: the spend cap of the runner and of the panel.
- `report.ts`: the metrics, the report tables and the selection rule.
- `images.ts`: the case images. Each image is one asset of the release `visual-bakeoff-images`, named by its SHA-256.
- `publish.ts`: the publish step of the images (`pnpm visual:bakeoff:publish`).
- `queue.ts`: the labeling queue of the owner in Langfuse (`pnpm visual:bakeoff:queue`).
- `capture.ts`: the capture step. It runs in the pinned capture container (`scripts/ci/visual-container.json`) with the play runner and the pins of the visual check.
- `mutations.ts`: the synthetic changes and their known regions.

The images are not in git. The manifest holds the SHA-256 of each image. Each image is one asset of the pre-release [`visual-bakeoff-images`](https://github.com/ctxpipe-ai/ctxpipe/releases/tag/visual-bakeoff-images) of this repository, named `<sha256>.png`. The images are screenshots of the Storybook stories, with their mock data, so they can be public.

## Build the cases

Run the command from the repository root. Docker must run.

```sh
pnpm visual:bakeoff:build [--seed 1] [--until <commit>] [--out .ci-results/visual-bakeoff]
```

The command does these steps:

1. It reads the first-parent history of `apps/ui/src` up to `--until`, and selects the newest 40 commits. A page renders many components, so the builder renders each page story of each commit, and the pixel diff finds the pages that changed. The page stories are the stories with the `page` tag in the build of `--until`. An older build has the same story ids.
2. It builds Storybook for each commit and each first parent, from a `git archive` export in a temporary folder. Commits with the same `apps/ui`, `packages` and lockfile trees share one build. Each build stays in `<out>/builds/`, so a second run builds only the missing ones.
3. It captures all screenshots at both viewports, in parts of at most 800 stories, with 8 capture containers at the same time. Then it captures again the screenshots of the candidates that make a case. A screenshot that is not the same in the two rounds gives no case. Each candidate has its own seeded rank, so a story that is steady in one run and not in another changes only its own case.
4. It compares each pair with the compare engine of the package, selects the cases with the seed, writes each image to `<out>/images/<sha256>.png`, and writes `cases.json`. A new case has only an after image.

The same seed and the same `--until` commit give the same cases. The `--until` commit must be in the history of `origin/main`, because the builder installs and builds each commit on the host. The output folder must be in the repository, because the capture container mounts only the repository.

A new build writes a new `cases.json`. It does not keep the panel votes, the labels of the owner or the taste picks. Run the panel again, or copy them to the new manifest.

## The judge panel

The judge panel labels the real changes ([CTX-1249](https://linear.app/ctxpipe/issue/CTX-1249)). Run the command from the repository root, after a build. It uses `MODEL_PROVIDER_API_KEY` (and `MODEL_PROVIDER_URL`).

```sh
node packages/visual-review/evals/critic/panel.ts [--models <list>] [--max-cost 40] [--images .ci-results/visual-bakeoff/images] [--cases <path>]
```

- **Members.** The default panel is `anthropic/claude-opus-5.5`, `openai/gpt-6.1-sol` and `google/gemini-4-argon`: one strong vision model of each of three families, through OpenRouter. `--models` gives another panel of 3 or more models.
- **Votes.** Each member judges each case that has a before image, on its own: no member sees the vote of another one. Each member gets the same prompt (`buildPanelPrompt` in `src/prompt.ts`): the scope, the measured regions, the brief, the two-layer rubric, and the images of the compare engine, as the critic gets them. The reply is a reason and one label: `improvement`, `regression` or `no-change`. A reply that is not usable, or a call that fails two times, gives no vote and an error.
- **Agreement rule.** A plain majority: a label counts when more than half of the members give it (2 of 3). Without a majority (for example, a failed vote and a tie), the case stays `unsure` and goes to the owner queue. A member with no vote stays in the count of the members.
- **Evidence for the rule.** On the first panel run (156 page cases, $4.81), the old rule (regression needs each member) was right on 100 of 119 synthetic cases and left 17 of 37 real changes without agreement. The plain majority is right on 105 of 119 and labels all 37 real changes (each disagreement was 2 against 1).
- **Labels.** The votes, with their reasons, and the panel label go into `cases.json` (the `panel` of each case, and `panelModels`). A real change gets the case label of the panel label: `intended` for `improvement`, `regression` for `regression`, `noise` for `no-change`. A real change without agreement keeps the label `unsure`: it leaves the scored set and goes to the owner queue. A synthetic case (`regression`, `noise`, `mixed`) keeps its known label: the panel result on it measures the panel, and the command prints how often each member and the panel are right. A `new` case has no before image, so the panel does not judge it, and it keeps the label of the builder.
- **Spend.** A call starts only while the spend is below `--max-cost`, with the rules of the runner. A case gets its panel only when each member gave its answer or an error. A second run, with the same models, judges the cases that have no panel yet, and again each case with an error vote: a short outage does not fill the owner queue. Run the panel again before `push` when the output gives errors.

## Publish the images

After a build that changes the images, run this command from the repository root. It needs the GitHub CLI, signed in with the right to write releases.

```sh
pnpm visual:bakeoff:publish [--images .ci-results/visual-bakeoff/images]
```

The command checks that each image of the manifest is in the folder and has its SHA-256. Then it uploads each image that the release does not have. If the release does not exist, the command creates it as a pre-release on `main`. An image that is missing or changed stops the command before an upload.

## Run the bake-off

Run the command from the repository root. The paid arms use `MODEL_PROVIDER_API_KEY` (and `MODEL_PROVIDER_URL`), so a fork can run the bake-off with its own key.

```sh
pnpm visual:bakeoff:run --arms <list> [--images .ci-results/visual-bakeoff/images] [--out .ci-results/visual-bakeoff/report] [--runs 3] [--max-cost 100] [--max-minutes <n>] [--concurrency 4] [--blazediff-agent <dir>] [--hold-out-only]
```

The runner gets the images of a case only when an arm judges the case: the limits let a call start, and the arm can judge that kind of case. It reads each image from the `--images` folder. If the image is not there, the runner downloads it from the release and keeps it in the folder. A missing image, or an image that does not have the SHA-256 of the manifest, stops the run with exit code 2. The report then has the verdicts so far. `--hold-out-only` runs only the hold-out cases, so the runner gets only their images. A case that the owner labeled `unsure` does not run.

An arm is a judge with its settings. `<model>` is an OpenRouter id.

| Arm | Judge |
| --- | --- |
| `llm:<model>` | The critic prompt: describe each side, then compare. |
| `llm-one-step:<model>` | The critic prompt with a one-step comparison. |
| `llm-no-facts:<model>` | The critic prompt without the interpreter facts: no change type and no confidence for a region, as when the interpreter is not available. |
| `jev` | Jev alone (`typesafe/jev-1.14`). |
| `decision:<model>` | Another decision model of the OpenRouter Decisions API, for example `baseten/elephant-1` or `baseten/mammoth-1`, with the questions of the Jev adapter. All decision models take the same request. Only Jev 1.14 takes the box question, so for another model the region of a worse area is the box of the largest measured region. |
| `cascade:<model>` | Jev, then `<model>` when Jev does not accept the change (the `--filter jev` of `pnpm visual:review`). |
| `cascade:<filter>+<model>` | The same cascade with the decision model `<filter>` in place of Jev. |
| `blazediff-local` | The local judge of BlazeDiff: Moondream describes each region, and Qwen classifies the change. It runs on the host at no cost. It needs `--blazediff-agent <dir>`: a folder with `@blazediff/agent` and `@huggingface/transformers`, installed with the pinned versions of the install step of the workflow. These packages are about 460 MB, so they are not dependencies of the repository. |

A `new` case has no before image. Each arm judges it with its judge of a new screenshot, as `pnpm visual:review` judges one:

- The three prompt arms (`llm`, `llm-one-step`, `llm-no-facts`) use the new-screenshot prompt (`judgeNewWithOpenRouter`). That prompt has no steps and no interpreter facts, so the three arms get the same prompt.
- `jev` and `decision:<model>` ask whether the screenshot breaks a rule of each area and each quality of the rubric (`judgeNewWithJev`). Only Jev 1.14 takes the box question. For another model, the region of a finding is the whole image.
- A `cascade` arm sends a new screenshot to its model, never to the filter, as `pnpm visual:review --filter jev` does.
- `blazediff-local` judges a pair of images, so it cannot judge a new screenshot. The report says "not applicable" for it, and the run makes no call.

The runner compares each pair with the compare engine of the package and gives each arm the same story input as `pnpm visual:review`. As in the critic, a case whose regions are all `rendering-noise` is `noise` with no call. An `llm-no-facts` arm has no change types, so this step does not apply to it. Each case has the scope of the manifest (`page`), so the page-only qualities apply.

The real changes have the labels of the judge panel. A real change with the label `unsure` (no panel label yet, no agreement, or the owner was not sure) does not run. The runner holds out 30% of the cases of each kind of change. A hash of the seed of the manifest and the case id selects them, so the same manifest gives the same set. A label of the owner does not change the set. All arms do all runs of the hold-out cases first. Then they do the other cases. A failed call gets one retry. If the retry fails, the verdict is `unsure` with an error.

Two limits stop the run. A paid call starts only while the spend is below `--max-cost`. After `--max-minutes`, no call starts. Each call checks both limits, also a retry, and a case gets its images only after the same check. Calls that already run finish, so a run can end above the cap by at most the cost of the calls in flight. A call without `usage.cost`, and a failed call, count as the most expensive call so far, and at least $0.10. The report gives the number of such calls. When a limit stops the run, the report counts only the cases and runs that every arm judged.

The runner writes `results.json` (each verdict of each arm, case and run) and `report.md` in `--out`, and prints the report.

## Report

The report has a table for the hold-out set and a table for the other cases. The labels of the real changes come from the judge panel. An arm whose model is a member of the panel has the mark "(panel)" after its name, because the panel labels can favor that model. Each table has one row for each arm:

- **Recall**: the share of the verdicts on `regression` cases that are `regression`. This is the main metric.
- **Precision**: the share of the `regression` verdicts that are on `regression` cases.
- **Unsure**: the share of the verdicts that are `unsure`. **Errors**: the number of verdicts with an error.
- **Severity agreement** and **Quality agreement**: the cases have no severity or quality labels. Thus, for each case and run, the report finds the most common severity of all arms, and the most common delta of each quality of the arms that rate it. The agreement is the share of the verdicts of the arm with the same value. Quality agreement is the mean over the qualities. A table at the end gives each quality.
- **Region overlap**: for each `regression` verdict on a case with a known region, the best intersection over union of a finding region and the known region (0 when the verdict has no finding). The value is the mean.
- **Consistency**: the share of the cases on which all runs of the arm give the same verdict.
- **Cost per story**: the mean of `usage.cost`, over the calls that gave one. It is `unknown` when no call gave one.
- **p50 ms** and **p95 ms**: the latency of the judge, as the adapters measure it.
- **Taste win rate**: from the `taste` picks in `cases.json`. A pick is a blind pairwise choice of the owner: a case, two arms, and the winner or `tie`. A win counts 1 and a tie counts 0.5, over the picks of the arm. The cells say "no labels yet" when the manifest has no picks.

**New screenshots:** a separate table, with one row for each arm. **Recall (broken)** is the share of the verdicts on the broken new screenshots that are `regression`. **False alarms (clean)** is the share of the verdicts on the clean new screenshots that are `regression`. The table also gives **Unsure**, **Errors**, **Cost per story** and the number of verdicts. It counts only the cases and runs that each arm with a judge of a new screenshot judged. The hold-out set, the other tables and the selection rule do not include the new screenshots.

**Selection rule:** of the arms with recall ≥ 0.9 and precision ≥ 0.7 on the hold-out set, the report selects the cheapest. Arms with the same cost per story (to $0.0001) tie, and the taste win rate breaks the tie. An arm with an unknown cost comes after the others.

## The workflow

`.github/workflows/visual-bakeoff.yaml` runs the bake-off or the judge panel by hand in the `workbench` environment, with its spend-capped `MODEL_PROVIDER_API_KEY`. The runner downloads the images of the cases that run from the release. `hold_out_only` runs only the hold-out cases. The workflow installs the local judge of BlazeDiff in its own folder, and runs the arms with `--max-cost` (default 90, a margin for the calls that already started below the $100 limit of the key) and `--max-minutes 300`. The job summary shows the report, and the artifact `visual-bakeoff-report` holds `report.md` and `results.json`.

With `panel`, the job runs the judge panel instead of the bake-off, with the spend cap of the panel ($40, the default of `panel.ts`; see the cost estimate in the pull request of [CTX-1249](https://linear.app/ctxpipe/issue/CTX-1249)). `panel_models` replaces the default panel when it is set. The artifact then holds the new `cases.json` with the votes: commit it in a pull request, and push the owner queue.

The default arms are the models of the plan in the three prompt arms, the three decision models (Jev, Elephant and Mammoth) alone, the cascade from each of them to Sonnet, and the local judge. A decision call costs much less than an LLM call, and a cascade calls Sonnet only when its filter does not accept the change, so a cascade arm costs at most the Sonnet arm. A full run of all the default arms costs more than $100. The hold-out cases go first, so a run that the cap stops still has the cases of the selection rule. To spend less, give fewer arms or fewer runs.

## The labeling queue

The owner labels in the Langfuse annotation queue `visual-bakeoff`. It has two score configs:

- `bakeoff-label`: `intended`, `regression` or `unsure`, for each real change (an `intended` case) on which the judge panel does not agree. `intended` is an improvement, or a change that is as good and adds no defect. The item shows the brief, the votes of the panel with their reasons, and the before and after images from the release.
- `bakeoff-pick`: `A`, `B` or `tie`, the blind pick of two critic outputs of one case. The item shows the case and the two outputs, with no arm and no model.

Run the commands from the repository root. `LANGFUSE_AUTH_STRING` is base64(`<public key>:<secret key>`) of the Langfuse project.

```sh
pnpm visual:bakeoff:queue push [--results <results.json>] [--pairs 60]
pnpm visual:bakeoff:queue export [--results <results.json>]
```

- `push` puts a label item for each real change without panel agreement into the queue. With the `results.json` of a run, it also puts in the blind picks: for each case, one pair of the arms that judged it in run 1 (a hash selects the pair and the order A, B), up to `--pairs` cases. A case that no judge saw (the noise step) gives no pair. An item that is in the queue already does not go in again.
- `export` writes the newest label of each queued real change into `cases.json`. With the same `results.json`, it also writes the picks into `taste`. A new pick of a case and two arms replaces the old one.
