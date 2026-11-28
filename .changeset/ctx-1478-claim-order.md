---
"@ctxpipe/aws-cdk": patch
---

fix: The workflow worker claims runs in the order they became available. Before, it claimed each new run first. Thus a parent run that its child had woken waited for a free worker slot while newer runs took each slot, for up to 32 minutes during an ingest (CTX-1478).
