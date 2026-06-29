---
"@ctxpipe/aws-cdk": patch
---

Fix GitHub repository setup so registering an installation no longer ingests all accessible repos before the user saves their selection. Select-mode saves now prune unselected connection-linked repositories and sync only chosen repos.
