---
"@ctxpipe/aws-cdk": patch
---

Answer from the tool results gathered so far when ctx_advisor's tool loop reaches its step limit, instead of failing the call. Each tool call and its error is logged on the process logger, and the advisor rephrases an empty search or fixes a failed call at most once.
