---
"@ctxpipe/aws-cdk": patch
---

Chat: a turn no longer repeats the AgentCore session check that its prepare just did, and it stops an earlier OpenCode server in the same command that stops the other processes of an earlier turn (AgentCore and Docker), so the first answer comes sooner.
