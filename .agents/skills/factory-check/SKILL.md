---
name: factory-check
description: Verify a change with `factory check` before each push. It runs the checks that the change can break and the review critics, and it stores the passes and the verdicts so that CI reuses them. Use before each push, instead of a full test suite, tests one by one, a sub-agent that only runs tests, or a review sub-agent.
---

# Verify a change with `factory check`

`factory check` is the private factory CLI. It runs all the checks of a change with one command. It does these steps on your working tree (uncommitted and untracked files included):

1. It selects the checks that the change can break, in every family (Vitest, Storybook, typecheck, lint, policy, build). Each selected check has a reason.
2. It reads the shared result store. A check whose inputs did not change since an earlier pass (from CI, a person, or an agent) is a hit and does not run.
3. It runs the misses with the public runner (`pnpm -s checks:run`).
4. It stores each new pass in the shared store. The merge gate of the pull request reads the store, so CI does not run that check again.
5. At the same time, it runs the review critics of the code-review skill on the committed diff of the branch. Each critic that has a hunk to review gets one headless reviewer (`claude` or `codex`). It stores each verdict for the merge gate. A rerun reviews only the hunks that changed or had a finding.

The contract of the checks is public: [`scripts/checks/README.md`](../../../scripts/checks/README.md).

## Procedure

1. Make sure that the host has its agent host certificate. A person provisions each host once (the factory CLI README, "Agent hosts"). Then `factory check` uses the `ctxpipe-factory-agent` profile, and no login is necessary. Do not set `AWS_PROFILE`, and do not use an admin SSO profile: an admin session writes no stored passes. When the run says that the shared store is off, or that the certificate expires soon, tell the user.

2. Commit the change. The critics review commits: with changes that are not committed, the run prints `CRITICS NOT RUN` and fails.
3. Run the check from the repo root. Give the ticket or the brief of the change with `--input`, so that the Spec critic can compare the change with it. Give the same files in each run of the branch:

   ```sh
   factory check --repo . --input <ticket or brief file>
   ```

4. Read the result. Each check line is `CACHED`, a passed check, or a failed check. A failure gives its log in `.ci-results/checks/`. Each critic line is `CARRIED`, `NOT APPLICABLE`, `PASSED`, `FAILED` or `ERROR`. Below a critic, each finding shows as `<severity> <file>:<line>: <summary>`.
5. Fix each failed check and each blocker and should-fix finding. Commit, then do step 3 again. A failed check always runs again; only a pass is stored. A critic reviews again only the hunks that changed or had a finding. A nit does not fail the run.
6. Read the stored passes and the last line. Each `STORED <id>` line says if the key is `portable` (CI can reuse the pass) or `host-specific` (only a host of the same OS and CPU architecture can reuse it). The last line counts the cache hits, the new passes, and the passes that are not storable, with the cause:

   ```text
   Result store: 3 cache hits reused; stored 4 new passes (4 portable, CI can reuse them; 0 host-specific, only this platform can reuse them); 1 not storable (1 without a cache key (stochastic, uncacheable or a missing key input)).
   ```

7. Push when the last line says that the checks and the critics passed. The merge gate shows each reused pass as a hit with class `agent`, and each critic as `carried` or `not-applicable`.

The verdicts belong to the branch (`<owner>/<repo>@<branch>`, from the `origin` remote), so you can run the critics before the pull request exists.

## Make your passes count in CI

A laptop pass counts in CI only when its key is portable and your local tool versions are the same as in CI:

- the Node version of `.node-version`,
- the pnpm version of `packageManager` in `package.json`,
- the Bun version of CI,
- a git with the same major and minor version as CI. Apple git is older: install git with `brew install git`.

`factory check` prints a `WARNING` line, with the fix, for each version that is not the same as in the newest nightly run on `main`. Fix each warning before you trust the cache. A different version gives a different key, so CI cannot reuse any of your passes, and no error tells you.

Until the factory release that the merge gate pins makes keys portable (the factory change "portable keys"), the key of each check holds the OS and the CPU architecture. Then a pass from macOS is `host-specific`, and CI on Linux cannot reuse it.

## Other lines in the output

- `LEFT TO CI <id>`: the check needs Docker, and Docker does not answer. The run does not fail, and no pass is stored: CI runs the check. Start Docker to run it here.
- `Waiting for a check slot`: other agents on this host run checks. The run waits for a free slot (one for each 4 CPUs), so that parallel agents do not overload the host.
- `ERROR critic:<name>` with a cause and a fix: a reviewer did not finish (the CLI is missing, a login or a quota, a timeout). The critic stores nothing, so the merge gate finds it missing. Do the fix and run again. Do not change the model.
- `ERROR critic:<name>` with "You've hit your usage limit ... try again at <time>": the Codex login is at its limit. The Codex reviewers use the login in `CODEX_HOME` (default `~/.codex`). When the host has a second Codex login in another folder (the host notes say where), use it for one run:
  1. Probe the other login with the model that stopped (the error names the critic; its models are in `critics.json`): `echo 'Reply OK' | CODEX_HOME=<folder> codex exec --ephemeral --skip-git-repo-check -m <model> -`.
  2. If it answers, run `factory check` again with `CODEX_HOME=<folder>` on the same command line. Do not export it, and do not change a file.
  3. When that login reaches its limit too, go back to the first login after the reset time of its error. Probe it first.
  4. When every login is at its limit, report the reset times and stop. Do not push before the critics pass, and do not loop.

  Never copy, print or move an `auth.json`, and never sign a login out.
- `CRITICS NOT RUN` with a fix: the tree is not committed, HEAD is not on a branch, or the shared store did not answer. Do the fix and run again.

## When a pass is not stored

- **No agent host certificate, an expired or revoked one, or an `AWS_PROFILE` that names other credentials.** The run still selects and runs the checks, but every check is a miss and no pass is stored. The output says `the shared store is off`. Do step 1, then run again: the earlier passes ran on your laptop only.
- **A check without a cache key.** A stochastic check (an eval, a latency bound) or an uncacheable check (an image build, a preview deploy) always runs in CI.
- **The inputs changed during the run.** Do not edit files while the checks run.
- **A host-specific key.** The pass is stored, but CI cannot reuse it. See [Make your passes count in CI](#make-your-passes-count-in-ci).
- **A dirty tree.** The pass is stored with the key of the working-tree text. CI reuses it only when a commit holds the same text. Commit before you push, and do not change the files after the run.

## Useful flags

- `--dry-run`: show the selection and the reasons; run nothing.
- `--cache-only`: show the hits and the misses; run nothing.
- `--no-cache`: run every selected check, also a hit. New passes are still stored.
- `--json`: one selection record, then one result record for each check.

## When `factory` is not installed

`factory` is in the private factory repo (`machines/cli`, build it with `cargo build --release` and put `target/release/factory` on `PATH`). Without it, run the lane commands as before: `pnpm -s checks:run <ids>` with the check ids from `pnpm -s checks:list`, or the test command of the package that you changed. A contributor from a fork never needs `factory`: CI runs the full suite for a pull request from a fork.

Do not start a sub-agent only to run tests, and do not start review sub-agents. `factory check` gives the same answer in less time, and CI can reuse it. Without `factory`, follow the code-review skill ("Without the factory") for the review.
