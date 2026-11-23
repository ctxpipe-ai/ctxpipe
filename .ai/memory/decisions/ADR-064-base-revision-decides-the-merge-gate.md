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

## Revision 2026-11-16: a definition change reuses the passes of its author

The product owner decided this on 2026-11-16. Checks run first on the agent host, with the result store. A CI run should get a hit for each check that `factory check` ran. Before this revision, a change to a gate input gave a full run, which reuses no stored pass. In 46.5 hours of PR runs, 23 runs were full. 7 of them changed only the baseline of one policy check.

The threat is the threat of this ADR: a fault, or an agent that wants its PR to pass, changes how checks are listed, run or keyed. Then a check that fails is gone from the selection, or a pass of its old definition counts.

- **A change to a definition of checks runs the selector.** The definitions are:
  - `list.mjs`, the family modules, `log.mjs` and the trace files;
  - `non-portable.json`;
  - the runner scripts `test-suite.mjs` and `storybook-play.mjs`, and the data files that they read;
  - the list-time files outside `scripts/checks/`, with the Storybook `main.ts`.
- **The key of each check that a definition can change holds it.** A Vitest or Storybook key holds `run.mjs` and its import closure, which has each family module. A project key holds `projects.mjs`. A data file is an input of its readers. Thus a pass of the old definition misses. A pass that the author stored with the new definition is a hit.
- **The base revision lists the same tree.** A PR could drop a check from its listing. It could also leave an input out of an entry, so that the key equals an old one. Thus the job Merge gate base listing lists the merge tree with the code and the dependencies of the base revision. Before any step runs a program of the checkout, the base versions replace the list-time files and each file that decides the tools and the install. The install uses a new store and no cache. The files of the PR are only data. The job uploads the listing with its artifact id as an output.
- **The plan compares the two listings.** The run is full in these cases:
  - Only the base listing gives a check.
  - A listing gives an id twice.
  - The own inputs of a check changed.
  - A check whose definition changed is in no selection, for example because the PR made it stochastic.
- **A check whose definition changed runs without a stored pass.** This is a check whose entry differs in a field other than `intent` and `inputs`, a check with fewer inputs, or a check that only the PR listing gives. More inputs only widen a key, so they keep the hit.
- **The LLM stage does not decide such a run.** The plan keeps the selection of the select job.
- **A data file of one check is a lane input.** Examples are `module-scope-values-baseline.json` and `page-story-exemptions.json`. Only the script of its own check reads it, and the key of that check holds it. `gate.mjs` names these files, so a new data file is a gate input until a person adds it.
- **Some `ci.yaml` steps of jobs without checks keep the selector.** No pull_request runs the nightly, trace, Results writer and layer cache jobs, so no PR run proves their steps. Each PR run runs the steps of Migrations in the same way. A change to another key of these jobs, such as `if:`, gives the full run.
- **These inputs keep the full run.**
  - `run.mjs`, `families.mjs`, `scripts/checks/prerequisites.mjs`, `scripts/ci/vitest-launch.mjs`, `scripts/ci/graph-ready.mjs` and `scripts/ci/prerequisites.mjs` run the checks of every family. A project key does not hold them.
  - Each check that runs in CI runs through `selected.mjs` and `rerun-failed.mjs`.
  - The record of `toolchain.mjs` is part of each key.
  - The manifest job installs with `.npmrc` and `patches/` before it lists.
  - Node loads a package from a committed `node_modules/` folder.
  - `.github/actions/**` and the other `ci.yaml` changes set up jobs in a way that no key holds.

### Consequences of the revision

- A definition change selects each check whose key holds the changed file. For a change to a family module, that is about 2,400 checks, because each Vitest and Storybook key holds `run.mjs`. CI runs only the checks that the author did not store.
- A change to a definition that also changes many check ids, such as a move of test files to another lane, gives a full run.
- A gated run proves the gated path of each check. The full-run path (`test-suite.mjs`, the screenshot job of a full run) is proven by the full nightly run on `main` (ADR-062).
- A project key does not hold `run.mjs`. To add it would let a change to the runner files reuse passes too, but every key would then change with any change to a family module.

## Revision 2026-11-23: a change to a runner file runs the selector

The CTO decided this on 2026-11-23 ([CTX-1556](https://linear.app/ctxpipe/issue/CTX-1556)). A PR changed 7 lines of `run.mjs`. Its CI run was full, and `factory check` ran almost every check on the agent host for about 2 hours before the push. A full run does not stop a hostile runner either: the check jobs run the runner of the PR in both modes. It protects against a runner fault. A smaller floor finds such a fault.

- **The runner files run the selector.** They are `run.mjs`, `selected.mjs`, `rerun-failed.mjs` and `scripts/ci/prerequisites.mjs`. No code that lists checks imports them, and a test keeps this true. Thus a runner change cannot change which checks exist or the entry of a check, and the base listing does not need to compare it.
- **The LLM stage decides.** The selector selects each check whose key holds the changed file, and the LLM stage keeps only the checks that the change can break.
- **A floor that the LLM stage cannot drop.** The plan runs every test of the CI scripts, which test the runner. Each job that runs checks through the runner must run at least one check. A job without one gets a canary: its check with the fewest seconds in the trace. A canary accepts no stored pass, so CI runs it with the runner of the PR.
- **These inputs keep the full run.** `families.mjs`, `scripts/checks/prerequisites.mjs`, `scripts/ci/vitest-launch.mjs` and `scripts/ci/graph-ready.mjs` run checks, but the listing imports them too. `toolchain.mjs` is part of each key.

### Consequences of the runner revision

- A runner fault that the LLM stage does not foresee and that no canary or test of the CI scripts finds reaches `main`. The full nightly run on `main` finds it (ADR-062).
- A screenshot check has `selectAll`, so a model step cannot drop it. The listing names the runner files of a check (`runnerInputs`), and the factory release that ctxpipe pins since CTX-1556 lets the LLM stage drop a screenshot check that only a runner input reached.
- `selected.mjs` is no longer a full-run input. A PR that changes how it reads `plan.json` meets the plan of the base revision in its own run. A mismatch fails the run, because the merge gate needs a record for each planned check.
- A canary is a real check of the job, so a flaky canary can fail the run. Its job runs a failed canary with a stored pass once more (Contradiction rule). In a gated run the upgrade job also runs its checks through `selected.mjs`, so this holds for an upgrade canary too (CTX-1557).
