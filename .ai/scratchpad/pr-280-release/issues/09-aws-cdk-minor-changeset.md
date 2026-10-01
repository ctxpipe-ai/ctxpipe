# Release @ctxpipe/aws-cdk as a minor

Status: needs-triage
Priority: P2
Owner: unassigned
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-01

## Context

User decision (2026-10-01): this branch ships as a minor, non-breaking `@ctxpipe/aws-cdk` release. `.changeset/git-backed-workspaces.md` currently declares `patch`. Ticket 03 adds the EC2 sandbox host to the construct.

## Plan (sketch)

1. Change the changeset to `minor`, rewrite its summary for operators (Workspaces, app DB role, sandbox host, upgrade steps: `pnpm update @ctxpipe/aws-cdk` + `cdk deploy`).
2. Before merge, re-check every changeset added on the branch for consistency.

## Comments

## Resolution
