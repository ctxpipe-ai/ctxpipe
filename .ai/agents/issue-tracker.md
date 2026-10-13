# Issue tracker: Linear

Issues, plans, and specs (you may know a spec as a PRD) for this repo live in Linear: team **CTX**, project **Product development**. Use the `linear-server` MCP tools. Write each issue id as a link: `https://linear.app/ctxpipe/issue/<ID>`.

## Conventions

- **One issue per ticket.** A large effort is an epic issue with sub-issues (`parentId`). Do not put many tickets in one issue.
- **Plans and specs** are Linear documents in the project. Link each document from its epic. A ticket copies the section of the plan that it implements into its description.
- **Milestone.** Add the milestone of the effort (for example "Workspaces (PR 280)") to each issue of that effort. Do not add a milestone to work outside the effort.
- **Dependencies** are Linear relations (`blockedBy`, `blocks`, `relatedTo`), not text.
- **No duplicates.** Before you create an issue, search Linear by title words and by the CTX ids that the work names (include archived issues).
- **Status.** Use the workflow states: `Backlog`, `Todo`, `In Progress`, `In Review`, `Done`, `Canceled`, `Duplicate`. A ticket that is merged into a long-lived feature branch, and that still waits for a preview or human check, stays `In Review` until that branch merges.
- **Triage roles** are the `Agent` labels and the `Triage` state (see [triage-labels.md](triage-labels.md)).
- **Comments** hold progress, decisions, and evidence, newest last. The final comment (or the description) holds the resolution: what shipped, the commits, the proof, and the follow-up issues.
- **Ticket notes.** The note that an implementing agent writes (what, why, tests, risks) goes in the issue description or a comment, not in a file in the repo.
- **Public repo, public text.** Never put a customer or organization name, slug, id, repository name, or email into an issue, a comment, or a document. Linear copies issue titles into branch names.

## Workflow rules

- **Plan review gate.** A ticket gets a plan (in its description) before work starts. No ticket moves to `Todo` with `ready-for-agent`, or to `In Progress`, before the user approves its plan. A material change of the plan goes back to the user.
- **Delegation brief.** Before you give a ticket to a sub-agent, write a brief that a cold agent can work from alone: inputs, files to read first, constraints, acceptance checks, and what to report back. Keep the brief outside the repo. Follow the sub-agent model rules in root `AGENTS.md`. Record the agent in a comment.
- **Claim.** Set `In Progress` and the assignee before you start. One owner per ticket.
- **Review before Done.** Each diff gets the three-axis adversarial review (Standards, Spec, Simplicity) through the [code-review skill](../../.agents/skills/code-review/SKILL.md), and the fixes, before the ticket is `In Review` or `Done`.
- **Split.** When a ticket grows, create follow-up issues and relate them in both directions.

## When a skill says "publish to the issue tracker"

Create a Linear issue in team CTX, project Product development, with the matching milestone and parent. For a spec or a plan, create a Linear document in the project and link it from the epic.

## When a skill says "fetch the relevant ticket"

Read the issue with `get_issue` (and its documents and comments when the work needs them). The user normally passes the CTX id or the URL.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an epic issue with one **child** sub-issue per question.

- **Map**: the epic description (Notes, Decisions so far, Fog). Put a long map in a Linear document linked from the epic.
- **Child ticket**: a sub-issue with the question in the description. The `Type` label records the ticket type (`Spike` for research and grilling, `Feature` or `Improvement` for a prototype, `Chore` for a task).
- **Blocking**: `blockedBy` relations. A child is unblocked when every blocker is `Done`.
- **Frontier**: the sub-issues of the epic in `Todo` that are unblocked and have no assignee; the oldest wins.
- **Claim**: set `In Progress` and the assignee before any work.
- **Resolve**: write the answer in a comment, set `Done`, then add a short pointer (gist and link) to Decisions so far in the epic.
