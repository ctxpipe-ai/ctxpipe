# Release @ctxpipe/aws-cdk as a minor

Status: in-progress
Priority: P2
Owner: claude
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-02

## Context

User decision (2026-10-01): this branch ships as a minor, non-breaking `@ctxpipe/aws-cdk` release. `.changeset/git-backed-workspaces.md` currently declares `patch`. Ticket 03 adds the EC2 sandbox host to the construct.

## Plan (sketch)

1. Change the changeset to `minor`, rewrite its summary for operators (Workspaces, app DB role, sandbox host, upgrade steps: `pnpm update @ctxpipe/aws-cdk` + `cdk deploy`).
2. Before merge, re-check every changeset added on the branch for consistency.

## Comments

- 2026-10-02 (claude): changeset set to `minor` with an operator summary. Still open: the sandbox host line (after ticket 03), and upgrade notes for existing data once ticket 06 checks the legacy export path on an upgraded stack.

## Resolution
