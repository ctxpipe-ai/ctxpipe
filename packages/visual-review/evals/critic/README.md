# Bake-off dataset of the visual critic

The bake-off compares critic models on a fixed set of labeled screenshot pairs ([CTX-1178](https://linear.app/ctxpipe/issue/CTX-1178), Phase 4). This folder holds the builder of that set. The runner and the report are a different ticket.

## Cases

| Kind | Count | How the builder makes it | Label |
| --- | --- | --- | --- |
| `intended` | 60 | A real commit that changed a story file or a component beside a story file. The builder renders the story at the first parent and at the commit. The brief is the commit message, with the pull request title when the GitHub CLI finds it. The old name of the required story set becomes `required` in a brief. | `intended` (the owner can change it) |
| `regression` | 8 × 10 | One CSS or DOM change on one element of a clean render, before the screenshot. The source does not change. The classes are in `mutations.ts`. | `regression`, with the class and the known region |
| `noise` | 2 × 10 | A transform below one pixel, or a thin text stroke, on the whole story. | `noise` |
| `mixed` | 20 | A real commit, with a synthetic regression in the after image. A mixed case can use the pair of an intended case; then the two cases differ only by the regression. | `regression`, with the class and the known region |

The builder keeps only the pairs that differ by more than the tolerance of the visual check (10 pixels). A mixed case must also show both parts: the real change and the regression. The stories in `scripts/ci/visual-unstable-stories.json` (desktop) give no case. A run that gives fewer than 150 cases stops and does not change the manifest. The known region is the box of the changed element before and after the change, 2 pixels wider on each side.

## Files

- `cases.json`: the case manifest. It is in git. Its schema is `cases.schema.json`, from `cases.ts`.
- `build.ts`: the builder (`pnpm visual:bakeoff:build`).
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
