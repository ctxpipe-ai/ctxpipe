---
"@ctxpipe/aws-cdk": patch
---

feature: Workspace sources: a plain git source file can pin a full commit SHA with the key `commit`. Each ingestion of a pinned repository reads that commit, not the tip of a branch, when each plain git source of the org that names the repository pins the same commit. The OrgBench corpus steps write such source files for the public repositories of a twin, in place of private snapshot copies.
