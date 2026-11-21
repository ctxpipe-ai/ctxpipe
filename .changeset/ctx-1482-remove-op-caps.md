---
"@ctxpipe/aws-cdk": patch
---

Ingestion has no op cap any more: a run of a large monorepo publishes all of its files. Before, a step took at most 30 ops and a Workspace at most 300 in a run. The skill scripts no longer page at 30 files: a page ends only at the size limits of a step, and the `dependencies` skill no longer skips each stream file after 28. A Workspace whose assemble is refused now publishes nothing, and the run span shows the refusal with the error status and the fixed codes of the cause (CTX-1482).
