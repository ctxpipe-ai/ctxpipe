---
"@ctxpipe/aws-cdk": patch
---

Workspace chat: a turn saves the question and its running state first, before the sandbox setup. When the user leaves a chat while its sandbox starts and then opens the chat again, the chat shows the question and the live progress, and then the answer. A turn that stops during the setup keeps the question and shows as stopped or failed.
