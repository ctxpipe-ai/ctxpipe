---
"ctxpipe": patch
---

Fix first-run GitHub pull-request mirror setup so context-repository binding is transactionally visible and background initialisation uses explicit organisation scope. Prevent OpenWorkflow's stale parallel-branch control signal from falsely marking successful repository ingestions as failed.
