# ADR-047: Durable write workflows

**Status:** Accepted (revised 2026-10-02) | **Date:** 2026-09-08 | **Tags:** git, openworkflow, workspaces, credentials

## Context

ctxpipe writes to the Workspace repository on the user's behalf: connector mirrors, extraction, imports, renames, link/unlink, ops folder maps, claim upgrades, file edits and bootstrap. These writes must survive worker loss, never force-push, never clobber concurrent human commits, and publish at most one commit per job. A generic write runner with agent choreography and per-file GitHub commits was replaced.

## Decision

- **One typed OpenWorkflow workflow per job kind** (`apps/backend/src/openworkflow/workflows/workspace-*.ts`): acquire → transform → stage → validate → commit → broker push → hydrate. OpenWorkflow owns retry; there is no second runner or scheduler.
- **Transforms are deterministic** over captured, immutable git data. They never run repository code and do not need a sandbox.
- **Durable step data is git, not a directory.** Steps carry a shallow pack plus its boundary and the target revision ([ADR-046](ADR-046-workspace-revision-projection-identity.md)); any worker can rebuild a disposable checkout. Commit subject and timestamp are inputs, so a replayed step makes the same commit. Credentials are issued per push and never stored in step data.
- **The write broker is the only pusher** (`write-broker.ts`). It checks the job's binding and the claims-only authority rule for `AGENTS.md` and linked declarations, then does a normal non-force push to the actual default branch. A successful push triggers hydrate with a read revision.
- **Concurrent tips:** when the default branch moved, the unpublished delta is replayed on the new tip. Overlapping text conflicts go to a `workspace-semantic-merge` child, which asks a model to resolve only the conflicting paths in a short-lived sandbox (created, used and destroyed as separate durable steps with an expiry cleanup). No push credential enters that sandbox.
- **Bootstrap** of an empty repository makes a real root commit through the same broker; if a human initializes the branch first, the job adopts that commit.
- **Ownership** of a run is scoped to the process OpenWorkflow namespace (`default` in production, `preview-pr-N` on previews) plus workflow name and version, so previews never adopt production work.
- **Writes are GitHub-only in v1.** Path assignments for imported objects are kept per Workspace binding so repeated extraction reuses paths instead of duplicating files.

## Consequences

- Worker or filesystem loss resumes from the last step; reruns do not double-commit.
- Every write is a normal commit on the default branch, visible in history and attributable.
- The semantic-merge sandbox uses the same provider choice as chat ([ADR-048](ADR-048-native-postgres-sandbox-ownership.md)).
