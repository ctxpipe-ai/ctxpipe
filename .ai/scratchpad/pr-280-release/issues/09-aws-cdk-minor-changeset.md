# Release @ctxpipe/aws-cdk as a minor

Status: in-progress
Priority: P2
Owner: claude
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-10

## Context

User decision (2026-10-01): this branch ships as a minor, non-breaking `@ctxpipe/aws-cdk` release. `.changeset/git-backed-workspaces.md` currently declares `patch`. Ticket 03 adds the EC2 sandbox host to the construct.

## Plan (sketch)

1. Change the changeset to `minor`, rewrite its summary for operators (Workspaces, app DB role, sandbox host, upgrade steps: `pnpm update @ctxpipe/aws-cdk` + `cdk deploy`).
2. Before merge, re-check every changeset added on the branch for consistency.

## Comments

- 2026-10-10 (claude): the upgrade run (latest published `@ctxpipe/aws-cdk`, then this branch) waits for an AWS login. The changeset upgrade notes wait for that run.

- 2026-10-05 (claude): sandbox host line added to `.changeset/git-backed-workspaces.md` and the text rewritten in Simplified Technical English. It names the new host, the optional `sandboxHost.instanceType` and `sandboxHost.dockerVolumeSizeGiB` props, no new required props, the upgrade (`pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`), and the `ghcr.io/ctxpipe-ai/chat-sandbox` image. Sizes and prices match `packages/aws-cdk/README.md`. Still open: upgrade notes for existing data. They wait for the ticket 06 run that checks the legacy export path on an upgraded stack; do not write them before that result. Plan step 2 (re-check every changeset on the branch) stays open until merge.

- 2026-10-02 (claude): changeset set to `minor` with an operator summary. Still open: the sandbox host line (after ticket 03), and upgrade notes for existing data once ticket 06 checks the legacy export path on an upgraded stack.

## Resolution
