# GitHub repository settings

The rulesets of `ctxpipe-ai/ctxpipe` are in `rulesets/`. Do not change them in the GitHub UI. Change the file, then run
`ops/github/apply-rulesets.sh` as a repository admin. The script creates or updates each ruleset by its name.

## `main`

- A pull request into `main` must have a passing `Merge gate` check from GitHub Actions (`.github/workflows/ci.yaml`,
  [`scripts/checks/README.md`](../../scripts/checks/README.md)). The job runs on each pull request into `main`, also on
  a fork pull request and on a pull request that changes no code.
- A repository admin can bypass the rule, but only when they merge a pull request. The release pull request
  (`changeset-release/main`) needs this: the changesets action opens it with `GITHUB_TOKEN`, so GitHub starts no
  workflow on it and it gets no `Merge gate` check.
