---
name: factory-check
description: Verify a change with `factory check`. It selects the checks that the change can break, reuses earlier passes, runs only the misses, and stores the new passes so that CI reuses them. Use before you commit or push a change, instead of a full test suite or a sub-agent that only runs tests.
---

# Verify a change with `factory check`

`factory check` is the private factory CLI. It does these steps on your working tree (uncommitted and untracked files included):

1. It selects the checks that the change can break, in every family (Vitest, Storybook, typecheck, lint, policy, build). Each selected check has a reason.
2. It reads the shared result store. A check whose inputs did not change since an earlier pass (from CI, a person, or an agent) is a hit and does not run.
3. It runs the misses with the public runner (`pnpm -s checks:run`).
4. It stores each new pass in the shared store. The merge gate of the pull request reads the store, so CI does not run that check again.

The contract of the checks is public: [`scripts/checks/README.md`](../../../scripts/checks/README.md).

## Procedure

1. Log in to the factory account once each day. The SSO session expires:

   ```sh
   aws sso login --profile ctxpipe-factory
   ```

2. Run the check from the repo root:

   ```sh
   AWS_PROFILE=ctxpipe-factory factory check --repo .
   ```

3. Read the result. Each line is `CACHED`, a passed check, or a failed check. A failure gives its log in `.ci-results/checks/`.
4. Fix each failure, then do step 2 again. A failed check always runs again; only a pass is stored.
5. Read the stored passes and the last line. Each `STORED <id>` line says if the key is `portable` (CI can reuse the pass) or `host-specific` (only a host of the same OS and CPU architecture can reuse it). The last line counts the cache hits, the new passes, and the passes that are not storable, with the cause:

   ```text
   Result store: 3 cache hits reused; stored 4 new passes (4 portable, CI can reuse them; 0 host-specific, only this platform can reuse them); 1 not storable (1 without a cache key (stochastic, uncacheable or a missing key input)).
   ```

6. Commit and push. The merge gate shows each reused pass as a hit with class `agent`.

## Make your passes count in CI

A laptop pass counts in CI only when its key is portable and your local tool versions are the same as in CI:

- the Node version of `.node-version`,
- the pnpm version of `packageManager` in `package.json`,
- the Bun version of CI,
- a git with the same major and minor version as CI. Apple git is older: install git with `brew install git`.

`factory check` prints a `WARNING` line, with the fix, for each version that is not the same as in the newest nightly run on `main`. Fix each warning before you trust the cache. A different version gives a different key, so CI cannot reuse any of your passes, and no error tells you.

Until the factory release that the merge gate pins makes keys portable (the factory change "portable keys"), the key of each check holds the OS and the CPU architecture. Then a pass from macOS is `host-specific`, and CI on Linux cannot reuse it.

## When a pass is not stored

- **No AWS credentials, or an expired SSO session.** The run still selects and runs the checks, but every check is a miss and no pass is stored. The output says `the shared store is off`. Do step 1, then run again: the earlier passes ran on your laptop only.
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

Do not start a sub-agent only to run tests. `factory check` gives the same answer in less time, and CI can reuse it.
