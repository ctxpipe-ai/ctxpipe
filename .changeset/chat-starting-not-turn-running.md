---
"@ctxpipe/aws-cdk": patch
---

While a chat sandbox starts (a prepare or a sandbox resume), file reads and Delete answer `chat_starting`, not `turn_running`. The file pane shows "The chat is starting…" and asks again by itself. Delete waits up to five seconds for the start to end, and then deletes the chat. If the chat still starts, Delete tells the user to try again in a few seconds. Pane errors show text with a next step, not a raw error code.
