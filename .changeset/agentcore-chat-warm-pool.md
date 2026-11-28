---
"@ctxpipe/aws-cdk": patch
---

improvement: A new AgentCore chat conversation claims a warm session of its Workspace that already holds the repository clone, so it skips the session create and the clone. Each Workspace keeps at most one warm session, and each organization at most three, for 12 minutes after chat use.
