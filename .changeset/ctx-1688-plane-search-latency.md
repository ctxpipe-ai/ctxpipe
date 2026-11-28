---
"@ctxpipe/aws-cdk": patch
---

fix: Knowledge plane: the search reads only the out-relations of its hits, a read of many documents no longer fails on the ClickHouse limit of one query parameter, and each ClickHouse read has a span.
