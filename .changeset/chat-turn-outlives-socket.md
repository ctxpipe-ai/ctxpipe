---
"@ctxpipe/aws-cdk": patch
---

Workspace chat: a turn continues on the server when the user leaves the conversation, and the answer is saved. When the user comes back, the conversation attaches to the running turn or shows the answer. Only the Stop control stops a turn. A turn that stops before its first answer keeps the question and shows a Retry action.
A turn stops after two hours. When a deploy or a crash stops the backend during a turn, the turn shows as stopped when the user opens the conversation again, and push and pull request are no longer blocked.
