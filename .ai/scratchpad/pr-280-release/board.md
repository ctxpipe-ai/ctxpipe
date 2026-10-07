# Board

Updated: 2026-10-07. Tickets are implemented by sub-agents in separate worktrees; each gets a three-axis adversarial review (Standards, Spec, Simplicity) and fixes before it is marked done. Rules: [README.md](README.md). Order is set by the user; unordered tickets follow.

| Order | # | Ticket | Status | Priority | Owner | Blocked by |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 01 | [Remove vendor patches](issues/01-remove-vendor-patches.md) | done | P0 | claude | — |
| 2 | 02 | [Vercel Sandbox for hosted chat](issues/02-vercel-sandbox-provider.md) | in-progress | P0 | claude (orchestrating) | 01 |
| 2 | 03 | [Docker sandboxing for self-hosters](issues/03-docker-sandbox-self-host.md) | in-progress | P0 | claude (orchestrating) | 01 |
| 3 | 12 | [Mirror merged PRs into every Workspace that links the repository](issues/12-github-pr-mirror-per-workspace.md) | done | P1 | claude | — |
| 3 | 04 | [End-to-end ingestion validator](issues/04-e2e-ingestion-validator.md) | in-progress (review fixes merged; ticket 14 is done, so the next paid n8n run can start) | P0 | claude (orchestrating) | — |
| 4 | 05 | [Ingestion performance from traces](issues/05-ingestion-performance.md) | plan-review | P1 | unassigned | 04 |
| 5 | 06 | [Browser end-to-end critical flows](issues/06-browser-critical-flows.md) | in-progress (decisions applied; first local run next) | P0 | claude (orchestrating) | 02 (final pass) |
| 6 | 09 | [Release @ctxpipe/aws-cdk as a minor](issues/09-aws-cdk-minor-changeset.md) | in-progress | P2 | claude | 03, 06 (final wording) |
| — | 07 | [Carry main's intent into Workspaces code](issues/07-carry-main-intent.md) | done | P0 | claude | — |
| — | 08 | [Consolidate intent and ADRs](issues/08-consolidate-intent-and-adrs.md) | done | P0 | claude | — |
| — | 10 | [Flaky SCIP indexer serialization test](issues/10-scip-indexer-test-flake.md) | done | P2 | claude | — |
| — | 11 | [Add a second Workspace from the UI](issues/11-add-workspace-entry-point.md) | done | P1 | claude | — |
| — | 13 | [Show knowledge files skipped as malformed on the Workspace page](issues/13-skipped-files-notice.md) | done | P2 | claude | — |
| — | 14 | [Extraction capture over 8 MiB fails ingestion](issues/14-extraction-capture-size.md) | done | P0 | claude | — |
| — | 15 | [A chat turn can send its final message but never finish](issues/15-turn-finish-hang.md) | done | P1 | claude | — |
| — | 16 | [Backend CI is red after the ticket 04 merge](issues/16-ci-red-after-ticket-04.md) | done | P0 | claude | — |
| — | 17 | [Follow-ups from ticket 16 and the Workspace base merge](issues/17-follow-ups-from-tickets-16-and-workspace-base.md) | needs-triage | P2 | unassigned | — |
| — | 18 | [PR 280 CI under 10 minutes from commit to green](issues/18-ci-under-ten-minutes.md) | done | P1 | claude | — |
| — | 19 | [The first turn of a new conversation does not stream](issues/19-first-turn-stream-lost.md) | done | P0 | claude | — |
| — | 20 | [Commit+Push is unreliable and Create PR does not work](issues/20-commit-push-create-pr-unreliable.md) | open: confirm the Create PR cause on the preview | P0 | claude | — |
| — | 22 | [Self-host (Docker) sandboxes hold no credential, through Agent Vault](issues/22-selfhost-sandbox-agent-vault.md) | in-progress | P0 | claude | — |
