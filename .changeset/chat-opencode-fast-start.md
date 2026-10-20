---
"@ctxpipe/aws-cdk": patch
---

A chat answer starts sooner. The chat agent no longer copies the repository for its own undo, watches its files, or builds a file search index before its first model call in each turn.

The backend also stops reconnecting to the chat agent of a finished turn after that agent stops.
