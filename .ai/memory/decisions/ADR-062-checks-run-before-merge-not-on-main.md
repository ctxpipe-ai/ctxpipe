# ADR-062: Checks run before the merge, not on a push to main

**Status:** Accepted (revised 2026-11-10: a thin nightly run) | **Date:** 2026-11-09 | **Tags:** ci, testing, factory

## Context

A pull request gets its proof in three places: on the agent host with `factory check`, in CI on the branch (the merge gate), and on `main`. Each extra run on `main` costs runner time and money and finds nothing that the merge gate did not prove. A review finding on [CTX-1191](https://linear.app/ctxpipe/issue/CTX-1191) (the screenshot lane) asked for a screenshot run on each push to `main`. The product owner decided that this is not a risk to accept. It is the design, and this ADR records it.

## Decision

- **The agent host proves the change.** Before each push, the agent runs `factory check`. It runs the checks that the change can break and the review critics, and it stores the passes and the verdicts.
- **CI on the branch reuses the proof.** The merge gate (`.github/workflows/ci.yaml`, [`scripts/checks/README.md`](../../../scripts/checks/README.md), Merge gate) runs only the selected checks that have no stored pass, and the critics gate makes no model call. A fork pull request and a run by hand get the full run.
- **A push to `main` runs no check.** No workflow runs a test, a lint, a typecheck, a build check, a screenshot or a critic of the product code on a push to `main`. A push to `main` does only this work:
  - `deploy.yaml` publishes: the release pull request, the npm packages and the deploy.
  - The Layer cache jobs of `ci.yaml` write the Docker layer cache that the branch builds read. Only `main` writes that cache, because all branches share one tag.
  - `observability.yaml` deploys the observability project when its files change. Its Terraform validation runs before the apply as a step of that deploy, not as a check of the change.
- **A thin nightly run of `main` audits the proof.** It starts only when `main` has a commit since the last successful nightly run. Then the jobs whose `if:` in `ci.yaml` names `schedule` run, and each flake and each failure makes a Linear ticket (the revision below gives the details). Project check times runs each typecheck, lint and policy check that has a cache key (it skips a check with `cacheable: false`, such as `policy:adr`). The test, Storybook plays and screenshots, codesearch, upgrade and build jobs run every check. The nightly run records the trace of `main` for `factory check` and writes the `ci` class of the result store. It finds a fault that two pull requests make together, a false pass in a stored result, and a flaky check. A new check, such as the screenshot lane, joins this nightly run. It does not get a job on push.

### Revision 2026-11-10: a thin nightly run

The product owner decided this on 2026-11-10 ([CTX-1245](https://linear.app/ctxpipe/issue/CTX-1245)). The full nightly run repeated work that the agent passes already cover, and nobody acted on its failures. The nightly run is there to trust the result store (the audit of the stored passes) and to record a fresh trace. It is not there to fill the cache. Thus the nightly run keeps only what it alone gives, and each of its signals makes work:

- **An unchanged `main` skips the run.** The first job (Nightly change) compares the commit of the run with the commit of the last successful scheduled run. When they are the same, no other job runs.
- **No second screenshot capture.** The Screenshot determinism job and its quarantine pull request job are removed. The flake signal comes from the contradiction rule: a screenshot or play check that fails and then passes in its rerun is a flake.
- **A flake makes a fix ticket.** For each flaky story, the job Nightly tickets opens one Linear ticket (state Todo, label `ready-for-agent`, parent [CTX-1178](https://linear.app/ctxpipe/issue/CTX-1178)) with the check ids, the run link and the link to the diff images. When the story already has an open ticket, the job adds a comment, and this second flake puts the story on the unstable list (`scripts/ci/visual-unstable-stories.json`) with that ticket and the date. The list change is a draft pull request (job Unstable screenshots). An entry older than 7 days fails the CI command regression tests.
- **A failed nightly run makes a ticket.** When a job of the nightly run fails, the job Nightly tickets opens one Linear ticket in Triage with the failed jobs and the run link.
- **The MCP evals have no schedule.** They run on a pull request with the `mcp-evals` label, or by hand.
- The Linear key is the `LINEAR_API_KEY` secret of the `workbench` environment. Without it, the job Nightly tickets gives an error annotation and fails. A pull request branch can also use the `workbench` environment, so use a restricted key: the team CTX only, with permission to read, create issues and create comments.

The incremental trace and a sampled audit are a separate change ([CTX-1246](https://linear.app/ctxpipe/issue/CTX-1246)).

## Consequences

- A fault that only the combination of two merged pull requests causes stays on `main` until the next nightly run, at most one day. The nightly run reports it in a Triage ticket, and the fix is a new pull request.
- On a day with no merge to `main`, no nightly run gives a new trace or a new audit. Nothing changed, so there is nothing new to prove.
- Do not add a job or a trigger on push to `main` for a check. Dispute a review finding that asks for one, and cite this ADR.
- The nightly run does not run Migrations, Terraform configuration, the Storybook required job, the Vercel sandbox contracts or an uncacheable lint or policy check. A fault that two merged pull requests make together in those checks shows only in the next pull request that selects them.
