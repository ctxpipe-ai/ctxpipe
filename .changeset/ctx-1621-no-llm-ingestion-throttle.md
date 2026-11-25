---
"@ctxpipe/aws-cdk": patch
---

Ingestion has no throttle of its own. More than one re-ingestion of an organization runs at the same time, and the source repositories of one re-ingestion run at the same time. Shards have at most 5 roots and start in a sliding window. Ingestion shards use at most half of the OpenWorkflow worker slots, so the other jobs keep the other half. The publishes to one Workspace run one at a time, so each publish lands.
