---
"@ctxpipe/aws-cdk": patch
---

improvement: A Workspace hydrate now writes only the knowledge units, chunks and graph nodes and edges that changed since the last hydrate. A full hydrate stays the fallback. One hydrate of a Workspace runs at a time, and each run hydrates the current tip of the branch.
