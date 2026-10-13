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
