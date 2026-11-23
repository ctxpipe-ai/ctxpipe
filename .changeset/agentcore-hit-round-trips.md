---
"@ctxpipe/aws-cdk": patch
---

Chat: a turn no longer repeats the AgentCore session check of its prepare. It stops an earlier OpenCode server in the same command that stops the other processes of an earlier turn (AgentCore and Docker). Thus the first answer comes sooner.
