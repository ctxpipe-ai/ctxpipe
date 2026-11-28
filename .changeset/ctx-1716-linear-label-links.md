---
"@ctxpipe/aws-cdk": patch
---

Knowledge plane: each Linear issue is `PART_OF` its parent issue, its project and its team, and `HAS_LABEL` each of its labels (all labels). Now `get_related` from a label returns the issues that have the label, and an agent can tell each relation apart. An id with no mirrored file makes no relation. The next projection run of each Workspace rebuilds it and adds the relations.
