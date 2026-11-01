---
"@ctxpipe/aws-cdk": patch
---

Workspace chat: the reply text is no longer lost when the event stream from the chat sandbox is slow. Before this fix, a turn could end with only its tool calls, and the stored conversation had no answer text.
