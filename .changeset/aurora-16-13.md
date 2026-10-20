---
"@ctxpipe/aws-cdk": patch
---

Fresh installs failed because AWS retired Aurora PostgreSQL 16.4 (`Cannot find version 16.4 for aurora-postgresql`). The construct now pins 16.13, the AWS default 16.x minor. The major version stays 16.

Upgrade: there are no new props. Run `pnpm update @ctxpipe/aws-cdk`, then `cdk deploy`. An existing cluster on 16.4 to 16.11 is upgraded in place to 16.13 (a short database restart). A cluster that is already on 16.13 does not change. CloudFormation does not replace the cluster. If you upgraded your cluster by hand to 16.14 or later, set your version on the cluster before you deploy (see "Aurora PostgreSQL minor version" in the README), because CloudFormation cannot move a cluster to a lower minor.
