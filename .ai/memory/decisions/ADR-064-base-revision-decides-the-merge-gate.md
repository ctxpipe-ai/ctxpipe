# ADR-064: The base revision decides the merge gate

**Status:** Accepted | **Date:** 2026-11-14 | **Tags:** ci, testing, factory, security

## Context

The merge gate ([`scripts/checks/README.md`](../../../scripts/checks/README.md), Merge gate; [ADR-062](ADR-062-checks-run-before-merge-not-on-main.md)) decides which checks a pull request must pass. Its jobs ran the gate code and read the pin of the PR checkout. Thus a PR that changed the gate code would decide its own selection, and every change to a gate input gave a full run. A full run costs about $1.00 to $1.20, and a gated run $0.06 to $0.17. About 1 in 9 PR runs was full for this reason, and close to half on days of CI work.

The threat is a change to the gate that removes a check from the selection of its own PR: a fault, or an agent that wants its PR to pass. The gate is not a control against a hostile author. GitHub runs the `pull_request` workflow of the merge revision, so a PR can change any job of `ci.yaml`. The root package scripts also run in the manifest job. The review critics and a person are the controls for those changes.

## Decision

- **The gate code and the pin come from the base revision.** The merge revision of a PR has `main` as its first parent. The manifest, plan and Merge gate jobs run `scripts/checks/gate.mjs` and read `.github/merge-gate.json` of the first parent (`git archive` to `$RUNNER_TEMP/gate`). The select, LLM and critics jobs hold a credential, so they read only the pin of the first parent. PR Deploy reads the mode of the base too. For a PR that does not change the gate, this is the same code.
- **The mode leaves the manifest job as an output.** The base gate code decides it before any PR code runs in that job, so later PR code cannot change it.
- **A gate input that no job of the PR run executes runs the selector.** These are `merge-gate.json`, `gate.mjs`, `plan.mjs`, `shard.mjs`, `schema.mjs` and `schema/*.json`. A test checks that no other source file imports or reads them. The new pin first selects the runs after the merge. The plan runs every test of the CI scripts (`policy:tests-*`) for such a change, so the LLM stage cannot drop a test of the changed gate code. Their keys hold the changed file, so a stored pass stays a hit.
- **A check of a job-scoped `ci.yaml` change gets no PR store hit.** An earlier run of the PR can have run it with another `ci.yaml` under the same key.
- **The other gate inputs keep the full run.** `ci.yaml` outside the steps of check jobs and `.github/actions/**` run from the PR, and only a full run proves a changed job graph. A module that lists and runs a family (`projects.mjs`, `evals.mjs`, `lanes.mjs`, `storybook.mjs`) decides which checks exist in its own run. A reference listing with the base code would run in the manifest job after PR code, so the PR could change what it reads. `list.mjs`, `families.mjs`, `run.mjs`, `selected.mjs`, `rerun-failed.mjs`, `log.mjs`, `prerequisites.mjs`, `visual.mjs`, `toolchain.mjs`, the trace files, the `scripts/ci` runners and data files, `.npmrc`, `patches/` and the list-time files outside `scripts/checks/` make or run the checks of several families or change every key.

## Consequences

- A PR that changes only the gate code, the schemas or the pin gets a gated run with the tests of the CI scripts.
- A change to the interface between `plan.json` and `selected.mjs` keeps working: the base writes the plan, and `selected.mjs` is a full-run input.
- A gate change that needs its own gate to pass cannot pass in its PR. Its run uses the base gate, or it is full.
- A new pin is not tried on its own PR. When it fails after the merge, the select job fails, and the runs are full until a fix. The factory repo tests each release.
- A check of a job-scoped `ci.yaml` change runs again on each push of its PR.

## Revision 2026-11-16: fewer full runs, and no reuse after a definition change

A PR that changed only the baseline of one policy check got a full run on each push. A full run costs about $1 more than a gated run. In 46.5 hours of PR runs, 7 of 23 full runs had only this cause.

- **A data file of one check is a lane input.** A data file in `scripts/ci` is a gate input only when the listing, a runner or a prerequisite reads it. Else only its own check reads it, and the key of that check holds it. The selector then runs that check, and the stored passes of the other checks count. A test keeps each data file in its group.
- **Some `ci.yaml` steps of jobs without checks do not give a full run.** No pull_request runs the nightly, trace, Results writer and layer cache jobs, so no PR run proves their steps, full or gated. Each PR run runs the steps of Migrations in the same way, so a gated run proves them. A changed line in the `steps` of these jobs is ignored like a comment. A change to another key, such as `if:`, gives the full run. A test evaluates the `if:` of each such job for a pull_request.
- **`non-portable.json` gives a full run.** It decides which keys hold the platform. A removed id let a pass of another platform count for a check that the selector did not select.
- **A change to a definition of checks keeps the full run, with no reuse.** The threat is a change to how checks or keys are defined that turns a failure into a stored pass of the old definition. A full run accepts no stored pass. A test walks the imports and reads of `list.mjs`, `run.mjs` and `selected.mjs`, and checks that each such file forces a full run, except the package files and a few files that each check that runs them holds in its key.
- **Rejected for now: reuse in the families that a change does not define.** The full run of a family does not depend only on the listing of the PR (the inventory of `test-suite.mjs`, each story of the Storybook index, the fixed matrix of the image builds). A gated run of the changed family would run only the checks of the PR listing. Thus it could not prove that the change drops no check. The plan has one mode for each run. To reuse the passes of the other families, the gate needs a mode for each job, or a listing of the base revision from a job that runs no PR code.
