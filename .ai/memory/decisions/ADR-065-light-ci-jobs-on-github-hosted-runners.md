# ADR-065: Light CI jobs, the test shards and the screenshots run on GitHub-hosted arm runners; the other Docker jobs stay on Blacksmith

**Status:** Accepted (amended: the Terraform jobs and the job that started PR Deploy are gone with the Railway deploy, [CTX-1220](https://linear.app/ctxpipe/issue/CTX-1220); revised 2026-11-22: the test shards and the screenshots move, and short Blacksmith jobs use 2 vCPU, [CTX-1505](https://linear.app/ctxpipe/issue/CTX-1505)) | **Date:** 2026-11-14 | **Tags:** ci, cost, factory

## Context

All CI jobs ran on Blacksmith arm64 runners, and Blacksmith bills each job by the minute. The repository is public. GitHub gives its standard hosted runners free and without a minute limit to a public repository. This includes `ubuntu-24.04-arm` (4 vCPU, 16 GB RAM, 14 GB SSD). The organization plan (Team) permits 60 concurrent jobs on GitHub-hosted runners. The GitHub Actions cache has 10 GB for each repository.

An evaluation on a closed draft pull request (3 attempts of each job) gave these medians, GitHub arm against Blacksmith 4 vCPU: queue 4 s against 6 s, the lint job 241 s against 262 s, the Storybook build 119 s against 128 s, and a backend test shard 565 s against 511 s. Docker and service containers start more slowly on the GitHub runner.

The cache key of a check holds the toolchain record ([`scripts/checks/toolchain.mjs`](../../../scripts/checks/toolchain.mjs)). The Merge gate manifest job writes one record for all lanes. The record holds the major and minor version of git. On 2026-11-14, the Blacksmith image had git 2.55 and the GitHub image had git 2.56. Each image changes its git when its owner updates the image. The git lanes are `backend`, `contracts`, `upgrade` and `cli`.

## Decision

- **Light jobs run on `ubuntu-24.04-arm` (GitHub-hosted).** In `.github/workflows/ci.yaml`: Lint and format, Typecheck, UI, CLI and CDK tests, Runnable packages and examples, Storybook build, and the merge gate jobs (manifest, selection, critics, LLM selection, plan, Merge gate). These jobs use no Docker build and no service container. Node, pnpm and Bun come from pinned setup actions. ast-grep is a root devDependency, which the lockfile pins with its hash. zoekt is built from `scripts/zoekt` (`go.mod` and `go.sum`) with Go from a pinned download that a SHA-256 checks. Thus these values are the same on both runners.
- **Heavy jobs and Docker jobs stay on Blacksmith.** The Storybook plays, the production and image builds, the layer cache, codesearch, the sandbox jobs, migrations, the upgrade job, the nightly jobs, and every job of `deploy.yaml`. The revision of 2026-11-22 (below) moves the test shards, the job Tests and the screenshots.
- **One pinned git for the record and the git lanes.** The action [`.github/actions/git`](../../../.github/actions/git/action.yaml) puts git 2.55.1 first on PATH. It builds git from the release tarball, which the SHA-256 checks, and the cache keeps the build. The Merge gate manifest job, the test shards, the UI, CLI and CDK tests and the upgrade job use it. Thus the record names the git that ran each check on both runner types, and an image update does not change a key. The version is the minor version of the nightly run before the move, so the stored passes stay valid. An agent host needs a git with the same major and minor version.
- **Merge gate plan and Merge gate move together.** They share the `merge-gate-pr-*` cache, and the GitHub cache is a different store from the Blacksmith cache.
- **Caches on `main` for the pull request jobs.** A pull request run can restore a cache of `main`, but not a cache of another pull request. A push to `main` runs no install job (ADR-062), so no other job saves the pnpm store on `main`. Then the first jobs of a pull request after a lockfile change miss the store: `pnpm install` takes 20 s to 27 s, against about 7 s with the store. The workflow `main-caches.yaml` runs on a push to `main` that changes `pnpm-lock.yaml`, `.node-version` or `apps/backend/converter/` (a `paths` filter, which compares the push before and after). Its job GitHub-hosted cache (`ubuntu-24.04-arm`) saves the pnpm store in the GitHub cache, and it restores or builds the file converter (see the revision below). Its job Blacksmith cache (`blacksmith-2vcpu-ubuntu-2404-arm`) saves the pnpm store in the Blacksmith cache. Each uses the key of the pull request jobs (setup-node keys the store by the OS, the architecture and the lockfile, not by the Node version). A later push does not cancel the workflow. When a nightly job of `ci.yaml` misses the store, it also saves it. The pinned git and zoekt have fixed keys, and the nightly run on `main` saves them (Merge gate manifest, and UI, CLI and CDK tests).
- **Policy.** Each GitHub-hosted `runs-on` has a `# github-hosted: <reason>` comment ([`scripts/ci/check-runners.mjs`](../../../scripts/ci/check-runners.mjs)). [`scripts/tests/ci-runners.test.mjs`](../../../scripts/tests/ci-runners.test.mjs) checks that a GitHub-hosted job has no Docker in its steps (except the jobs of its list, see the revision below) and uses no Blacksmith action, that the manifest job and the git lanes use the pinned git, and that the cache jobs use the keys of the pull request jobs.

## Consequences

- The Blacksmith cost of each pull request run goes down by the minutes of the moved jobs. The moved jobs are free.
- The first run of the pinned git on a runner type builds git (about 2 minutes). After that, the cache gives it in seconds.
- A pull request run uses at most about 15 GitHub-hosted jobs at a time (about 30 after the revision below). The limit is 60 concurrent jobs for the organization. When the queue time increases, move the merge gate jobs back first.
- To revert, set each moved `runs-on` back to `blacksmith-2vcpu-ubuntu-2404-arm` or `blacksmith-4vcpu-ubuntu-2404-arm` and remove its comment. The steps stay the same. Then remove the job GitHub-hosted cache of `main-caches.yaml`, and keep the job Blacksmith cache.
- To change the git version, change the version and the hash in the action. Each key of a git lane then changes once, and the next nightly run stores new passes.
- A push that changes the lockfile runs two more short jobs (they fill a cache and run no check), see [ADR-062](ADR-062-checks-run-before-merge-not-on-main.md).

## Revision 2026-11-22: the test shards and the screenshots move

The CTO decided this in the cost review of 2026-11-22 ([CTX-1505](https://linear.app/ctxpipe/issue/CTX-1505)): "B1, B2, B5: ok do that, and try to keep the speed as close to the blacksmith". From 15 to 21 November, Blacksmith cost about $470 a month, and ctxpipe was about 70% of it. The test shards cost about $148 a month and the screenshots about $39. The light jobs of `deploy.yaml` ($6 to $16 a month) move in a separate change.

### Decision of the revision

- **The test shards and the job Tests run on `ubuntu-24.04-arm`.** The shards use service containers, FalkorDB and the chat sandbox image, and a GitHub-hosted runner runs Docker. The job Tests checks the Vitest reports of the shards, which hold absolute paths of the workspace of the shard runner (`/home/runner/work` on GitHub), so it moves with them.
- **The Storybook screenshots run on `ubuntu-24.04-arm`.** The capture runs in the pinned Playwright image (`scripts/ci/visual-container.json`, `linux/arm64`), not on the runner, so the move changes no screenshot. The first runs on GitHub matched each committed baseline.
- **Speed on GitHub.** The time of the tests is the same on both runners: the sum of the file times of the backend and contract shards was 4,417 s on GitHub against 4,613 s on Blacksmith (the same 696 files). The setup of a shard is longer on GitHub. The runner has no image cache and no colocated cache. Before the changes below, a shard spent 138 s to 157 s outside its tests, against 80 s on Blacksmith. This time is the queue, the setup and the teardown, with a cached converter. These changes keep the time of a run:
  - `scripts/ci/test-weights.json` holds the measured time of each backend and contract file of 5 s or more. It held only 18 backend files, so one backend shard got most of the long files (805 s of file time against 350 s in another shard).
  - A full run has 5 backend shards (it had 4), so the database profile of `shard.mjs` has at most 10 shards.
  - The image pulls of the contract tests and the build of the chat sandbox image run in the background while the toolchain installs.
  - The Postgres service checks its health every second while it starts.
  - `main-caches.yaml` builds the file converter in the GitHub cache on each push to `main` that changes it. Before, each pull request run after a converter change built it in each shard (about 200 s).
- **Measured times.** Blacksmith: the pull request runs of 15 to 21 November (medians). GitHub: the full runs of PR #989 with these changes, with a cached converter (see the PR for each run).

  | Time | Blacksmith | GitHub |
  | --- | --- | --- |
  | Full run, first job to Merge gate | 1,086 s (31 runs; 1,322 s in the 8 runs of 21 November) | 915 s, 826 s |
  | Slowest test shard of a full run | 993 s (1,137 s on 21 November) | 837 s, 753 s |
  | A shard outside its tests (queue, setup, teardown) | 80 s | 93 s (backend), 110 s (contracts) |
  | Screenshots shard of a full run | 504 s | 472 s to 525 s |

  A gated run has fewer shards, so the setup of a shard counts more. A gated run with tests took 431 s (median) on Blacksmith. With 13 s to 30 s more for each shard, it takes about 3% to 7% longer on GitHub.
- **GitHub-hosted jobs with Docker.** The test shards and the screenshots (the Playwright container, which `scripts/ci/visual-capture.mjs` starts). The policy test reads only the steps of a job, so it lists only the test shards. Each other GitHub-hosted job has no Docker in its steps, and no GitHub-hosted job uses a Blacksmith action.

### Consequences of the revision

- Blacksmith cost goes down by about $187 a month. The remaining Blacksmith jobs of ctxpipe are the Storybook plays, the production builds, the layer cache, codesearch, migrations, the upgrade job, the nightly jobs and the jobs of `deploy.yaml`.
- A full pull request run uses about 30 GitHub-hosted jobs at a time. In the 7 days before the move, at most 11 GitHub-hosted jobs of ctxpipe ran at the same time. With the moved jobs of those days, the peak is 33, and more than 30 ran for 2 minutes in the week. The limit of 60 holds about two full runs at the same time with the other jobs.
- A pull request run on GitHub does not get the image cache of Blacksmith, so it pulls each image again. Docker Hub does not limit the pulls of a GitHub-hosted runner.
- To revert the revision, set each moved `runs-on` back to `blacksmith-4vcpu-ubuntu-2404-arm` (the shards and the screenshots) or `blacksmith-2vcpu-ubuntu-2404-arm` (the job Tests), and remove its comment. The background steps work on both runners.

### Second part of the revision: 2 vCPU for short jobs, a shorter shard limit; the Storybook plays stay

The CTO approved these items of the same cost review on 2026-11-22 (B3, B6 and B9 of [CTX-1505](https://linear.app/ctxpipe/issue/CTX-1505)).

- **The Storybook plays stay on Blacksmith.** The CTO approved their move too (B3, about $28 a month). On GitHub (PR #1003, runs 44995446453 and 44997229475) the plays were faster: a plays shard took 297 s to 322 s against 310 s on Blacksmith, and the run of its plays 228 s against 257 s. But 2 of 11 shard runs failed, each on one story of `features/connectors` whose first `findByText` did not find its text in 1 s (once the story was still in `sb-preparing-story`). On Blacksmith, no plays shard failed from 21 to 22 November. The plays move when the cause is known.
- **Short Blacksmith jobs use 2 vCPU when they stay under one minute.** Blacksmith bills each started minute, so a job of 30 s to 60 s on 4 vCPU costs no less on 2 vCPU. The production builds and the layer cache builds of chat-sandbox, codesearch and cost-telemetry took about 20 s (median) on 4 vCPU, and they use 2 vCPU. The other builds took 27 s to 190 s (median, or up to 185 s in 1 of 10 runs) and keep 4 vCPU. Each matrix picks the label of each entry with an expression, and `check-runners.mjs` allows an expression when each label in it is an arm64 Blacksmith label. Migrations keeps 4 vCPU: on 2 vCPU it took 70 s without the converter build (49 s on 4 vCPU). The release job of `deploy.yaml` moves to a GitHub-hosted runner with the other light deploy jobs (B5, a separate change).
- **A shorter limit for a test shard.** A test shard job stops after 30 minutes (it was 45 and 60). In a full run, `test-suite.mjs` stops a backend or contract shard after 20 minutes (it was 30 and 45), so its named error comes before the job limit.
- **Measured times** of the 2 vCPU builds (PR #1003, runs 44995446453 and 44997229475): the production builds of chat-sandbox, codesearch and cost-telemetry took 17 s to 19 s on 2 vCPU (19 s to 33 s, median, on 4 vCPU). They start after the plan job and end long before the test shards, so they are not on the critical path. The layer cache runs only on `main`, so its 2 vCPU times come from the first pushes after the merge.
- To revert the second part, set the label expressions of the production builds and the layer cache back to `blacksmith-4vcpu-ubuntu-2404-arm`, and set the limits back: the job limit to 60 minutes (contracts and selected) and 45 minutes (backend), and the shard limit of `test-suite.mjs` to 45 minutes (contracts) and 30 minutes (backend).
