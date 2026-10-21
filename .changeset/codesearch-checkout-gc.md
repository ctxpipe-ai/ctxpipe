---
"@ctxpipe/aws-cdk": patch
---

Codesearch deletes old checkouts. Each ingested commit and each Workspace revision kept a full clone, Zoekt shards, and SCIP files on the codesearch volume, and the volume grew without a limit. The worker now deletes the checkouts that no reader needs, after each repository publish and every hour. The first run after the upgrade cleans every repository.
