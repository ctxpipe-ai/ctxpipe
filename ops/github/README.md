# GitHub repository settings

The rulesets of `ctxpipe-ai/ctxpipe` are in `rulesets/`, and the branch policies of its environments that hold
secrets for main only are in `environments/`. Do not change them in the GitHub UI. Change the file, then run
`ops/github/apply.sh` as a repository admin. The script creates or updates each ruleset and environment by its name.
An environment's secrets are not in the files: set them in Settings > Environments.

## `main`

- A pull request into `main` must have a passing `Merge gate` check from GitHub Actions (`.github/workflows/ci.yaml`,
  [`scripts/checks/README.md`](../../scripts/checks/README.md)). The job runs on each pull request into `main`, also on
  a fork pull request and on a pull request that changes no code.
- A repository admin can bypass the rule, but only when they merge a pull request. The release pull request
  (`changeset-release/main`) needs this: the changesets action opens it with `GITHUB_TOKEN`, so GitHub starts no
  workflow on it and it gets no `Merge gate` check.

## `workbench-main`

Only `main` can deploy to it (a custom branch policy, not "Protected branches only": that setting counts classic branch
protection rules, and `main` is protected by a ruleset). It holds the keys of the jobs that run only from main: the
Linear key of Nightly tickets, and the GitHub App, repositories and model key of the ingestion v2 proof. A workflow on a
pushed branch cannot read them. `workbench` keeps the spend-capped and test-scoped keys that pull request jobs need.
