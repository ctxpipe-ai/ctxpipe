---
"@ctxpipe/aws-cdk": patch
---

Hydrate: the `claims_upgrade` write job no longer adds a claim with only `to` to a file that ingestion v2 owns. The v2 validator refuses such a claim, so each later ingestion step that kept the front matter of the file failed. The job now removes each claim with no evidence from such a file. A body link still makes its `LINKS_TO` edge.
