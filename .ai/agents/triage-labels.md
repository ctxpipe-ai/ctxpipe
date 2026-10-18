# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the states and labels of this repo's issue tracker (Linear, team CTX; see [issue-tracker.md](issue-tracker.md)).

| Label in mattpocock/skills | In our tracker | Meaning |
| -------------------------- | -------------- | ------- |
| `needs-triage`             | state `Triage` | Maintainer needs to evaluate this issue |
| `needs-info`               | label `Agent` / `needs-info` | Waiting on reporter for more information |
| `ready-for-agent`          | label `Agent` / `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human`          | label `Agent` / `ready-for-human` | Requires human implementation or decisions |
| `wontfix`                  | state `Canceled` (reason in a comment) | Will not be actioned |

When a skill mentions a role (for example "apply the AFK-ready triage label"), use the corresponding state or label from this table. The `Agent` labels are one group, so an issue has at most one of them. Use the label `Needs decision` when work cannot start until the owner decides; write the question in the description.

## How the labels relate to the statuses

The workflow statuses are the main signal (see [issue-tracker.md](issue-tracker.md)): `Backlog` (not ready), `Todo` (ready for an agent), `In Progress` (an agent works on it), `Waiting for human` (blocked on a human), `Done`. The `Triage` state is the inbox: a new issue waits there until a maintainer moves it to `Backlog` or `Todo`.

The `Agent` labels add detail and do not replace a status:

- `ready-for-agent` matches status `Todo`. Use the status. Add the label only for an issue that comes from triage.
- `ready-for-human` and `needs-info` match status `Waiting for human`. Name the human action in a comment.
- `Needs decision` is an extra label for a ticket that waits for the owner's answer. The ticket is in `Waiting for human` when work has started, or in `Backlog` when it has not.
