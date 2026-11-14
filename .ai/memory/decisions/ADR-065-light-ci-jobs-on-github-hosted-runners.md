# ADR-065: Light CI jobs run on GitHub-hosted arm runners; heavy and Docker jobs stay on Blacksmith

**Status:** Accepted | **Date:** 2026-11-14 | **Tags:** ci, cost, factory

## Context

All CI jobs ran on Blacksmith arm64 runners, and Blacksmith bills each job by the minute. The repository is public. GitHub gives its standard hosted runners free and without a minute limit to a public repository. This includes `ubuntu-24.04-arm` (4 vCPU, 16 GB RAM, 14 GB SSD). The organization plan (Team) permits 60 concurrent jobs on GitHub-hosted runners. The GitHub Actions cache has 10 GB for each repository.

An evaluation on a closed draft pull request (3 attempts of each job) gave these medians, GitHub arm against Blacksmith 4 vCPU: queue 4 s against 6 s, the lint job 241 s against 262 s, the Storybook build 119 s against 128 s, and a backend test shard 565 s against 511 s. Docker and service containers start more slowly on the GitHub runner.

The cache key of a check holds the toolchain record ([`scripts/checks/toolchain.mjs`](../../../scripts/checks/toolchain.mjs)). The Merge gate manifest job writes one record for all lanes. The record holds the major and minor version of git. On 2026-11-14, the Blacksmith image had git 2.55 and the GitHub image had git 2.56. Each image changes its git when its owner updates the image. The git lanes are `backend`, `contracts`, `upgrade` and `cli`.

## Decision

- **Light jobs run on `ubuntu-24.04-arm` (GitHub-hosted).** In `.github/workflows/ci.yaml`: Lint and format, Typecheck, UI, CLI and CDK tests, Runnable packages and examples, Storybook build, Terraform configuration, and the merge gate jobs (manifest, selection, critics, LLM selection, plan, starts PR Deploy, Merge gate). These jobs use no Docker build and no service container. Node, pnpm and Bun come from pinned setup actions, and zoekt and ast-grep from pinned downloads, so these values are the same on both runners.
- **Heavy jobs and Docker jobs stay on Blacksmith.** The test shards, the Storybook plays and screenshots, the production and image builds, the layer cache, codesearch, the sandbox jobs, migrations, the upgrade job, the nightly jobs, and every job of `deploy.yaml` and `pr-deploy.yaml`. The job Tests also stays: it checks the Vitest reports of the shards, which hold absolute paths of the Blacksmith workspace (`/home/runner/_work`; the GitHub runner uses `/home/runner/work`).
- **One pinned git for the record and the git lanes.** The action [`.github/actions/git`](../../../.github/actions/git/action.yaml) puts git 2.55.1 first on PATH. It builds git from the release tarball, which the SHA-256 checks, and the cache keeps the build. The Merge gate manifest job, the test shards, the UI, CLI and CDK tests and the upgrade job use it. Thus the record names the git that ran each check on both runner types, and an image update does not change a key. The version is the minor version of the nightly run before the move, so the stored passes stay valid. An agent host needs a git with the same major and minor version.
- **Merge gate plan and Merge gate move together.** They share the `merge-gate-pr-*` cache, and the GitHub cache is a different store from the Blacksmith cache.
- **Caches on `main` for the pull request jobs.** A pull request run can restore a cache of `main`, but not a cache of another pull request. The job GitHub-hosted cache runs on each push to `main` and saves the pnpm store (the key of `actions/setup-node`) and the Terraform providers (the key of Terraform configuration), because a merge can change their keys. The pinned git and zoekt have fixed keys, and the nightly run on `main` saves them (Merge gate manifest, and UI, CLI and CDK tests).
- **Policy.** Each GitHub-hosted `runs-on` has a `# github-hosted: <reason>` comment ([`scripts/ci/check-runners.mjs`](../../../scripts/ci/check-runners.mjs)). [`scripts/tests/ci-runners.test.mjs`](../../../scripts/tests/ci-runners.test.mjs) checks that a GitHub-hosted job uses no Docker, that the manifest job and the git lanes use the pinned git, and that the cache job uses the keys of the pull request jobs.

## Consequences

- The Blacksmith cost of each pull request run goes down by the minutes of the moved jobs. The moved jobs are free.
- The first run of the pinned git on a runner type builds git (about 2 minutes). After that, the cache gives it in seconds.
- A pull request run uses at most about 15 GitHub-hosted jobs at a time. The limit is 60 concurrent jobs for the organization, so 4 or more pull request runs at the same time can wait in the queue. When the queue time increases, move the merge gate jobs back first.
- To revert, set each moved `runs-on` back to `blacksmith-2vcpu-ubuntu-2404-arm` or `blacksmith-4vcpu-ubuntu-2404-arm` and remove its comment. The steps stay the same. Then the job GitHub-hosted cache is unnecessary; remove it.
- To change the git version, change the version and the hash in the action. Each key of a git lane then changes once, and the next nightly run stores new passes.
- A push to `main` runs one more job (it fills a cache and runs no check), see [ADR-062](ADR-062-checks-run-before-merge-not-on-main.md).
