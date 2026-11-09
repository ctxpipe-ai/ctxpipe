# ADR-062: Checks run before the merge, not on a push to main

**Status:** Accepted | **Date:** 2026-11-09 | **Tags:** ci, testing, factory

## Context

A pull request gets its proof in three places: on the agent host with `factory check`, in CI on the branch (the merge gate), and on `main`. Each extra run on `main` costs runner time and money and finds nothing that the merge gate did not prove. A review finding on [CTX-1191](https://linear.app/ctxpipe/issue/CTX-1191) (the screenshot lane) asked for a screenshot run on each push to `main`. The product owner decided that this is not a risk to accept. It is the design, and this ADR records it.

## Decision

- **The agent host proves the change.** Before each push, the agent runs `factory check`. It runs the checks that the change can break and the review critics, and it stores the passes and the verdicts.
- **CI on the branch reuses the proof.** The merge gate (`.github/workflows/ci.yaml`, [`scripts/checks/README.md`](../../../scripts/checks/README.md), Merge gate) runs only the selected checks that have no stored pass, and the critics gate makes no model call. A fork pull request and a run by hand get the full run.
- **A push to `main` runs no check.** No workflow runs a test, a lint, a typecheck, a build check, a screenshot or a critic of the product code on a push to `main`. A push to `main` does only this work:
  - `deploy.yaml` publishes: the release pull request, the npm packages and the deploy.
  - The Layer cache jobs of `ci.yaml` write the Docker layer cache that the branch builds read. Only `main` writes that cache, because all branches share one tag.
  - `observability.yaml` deploys the observability project when its files change. Its Terraform validation runs before the apply as a step of that deploy, not as a check of the change.
- **One nightly run of `main` is the safety net.** The jobs whose `if:` in `ci.yaml` names `schedule` run in full. Project check times runs every typecheck, lint and policy check. The test, Storybook plays and screenshots, codesearch, upgrade and build jobs run every check. The nightly run also records the trace of `main` for `factory check` and writes the `ci` class of the result store. It finds a fault that two pull requests make together, and a false pass in a stored result. A new check, such as the screenshot lane, joins this nightly run. It does not get a job on push.

## Consequences

- A fault that only the combination of two merged pull requests causes stays on `main` until the next nightly run, at most one day. The nightly run reports it, and the fix is a new pull request.
- Do not add a job or a trigger on push to `main` for a check. Dispute a review finding that asks for one, and cite this ADR.
- The nightly run does not run Migrations, Terraform configuration, the Storybook required job or the Vercel sandbox contracts. A fault that two merged pull requests make together in those checks shows only in the next pull request that selects them.
