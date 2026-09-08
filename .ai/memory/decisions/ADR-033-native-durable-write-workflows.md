# ADR-033: Native durable write workflows

**Status:** Accepted | **Date:** 2026-09-08 | **Tags:** git, openworkflow, workspaces, credentials

## Context

The accepted recovery plan's Gate 3 replaces the generic write runner, agent choreography and GitHub per-file commit exception. The locked ingest protocol still requires one concern per job, at most one commit, actual-default-branch writes, GitHub-only v1 write policy, semantic conflict resolution, paused-current-binding resume, and hydrate after push. The implementation must survive worker and filesystem loss without a second scheduler or sandbox lifecycle.

## Decision

- OpenWorkflow owns execution and retry. Each job kind has a typed registered workflow with explicit acquire, transform, stage, validate, commit, push-admission/broker, and publication steps. Ordinary pure transforms and native Git primitives can be shared; no second runner state machine is introduced.
- Deterministic transforms run against captured immutable Git data. They do not execute repository code or need an agent sandbox. The semantic conflict operation retains the isolation required by the locked ticket; no push credential enters it.
- Durable step data contains native Git objects and their immutable identity, not a worker-local directory or credentials. A shallow Git pack plus its native shallow boundary restores the acquired tree without full-history fetches. Each step may reconstruct and remove a disposable directory. Commit subject and timestamp are durable inputs so reconstruction creates the same commit.
- Job status reconciles terminal owning OpenWorkflow state in a short org SQL query, filtered by org, workspace and job identity. Native step retries remain running; no workflow catch block guesses whether a retry is terminal.
- The job-to-commit mapping is recorded before push; completed status follows successful publication. A retry checks the actual remote for the recorded commit before doing another write. Push failures do not revert Git. Hydration uses the canonical default revision containing the committed change and retries independently. Native ancestry recovers a lost push acknowledgement even when a subsequent writer has advanced the tip; completion requires a durable hydrate enqueue.
- Only the workflow's brokered push step obtains a repository-scoped write credential. Sandbox and codesearch consumers receive read credentials. GitHub feature-branch configuration PRs and conversation session branches remain supported, with explicit default-branch exclusion.
- Preserve short org SQL transactions (ADR-027/028); no SQL connection or transaction is held across Git, provider, or model I/O. Full binding identity is checked immediately before push, and native Git rejects non-fast-forward updates. Never rewrite default-branch history or create a protection-workaround PR.

This implements the recovery plan's explicit replacement of ticket 10's generic runner, shared sandbox for mechanical jobs, and mechanical GitHub API exception. It preserves its product behavior and semantic-conflict isolation rather than applying the old orchestration literally.

## Consequences

Worker restart can reconstruct a job's Git artifacts. Durable packs add storage proportional to the acquired tree; they contain repository data but no credentials. Step identities, command admission, remote uncertainty, per-kind retry bounds, and every former default writer require native acceptance proof before Gate 3 closes.
