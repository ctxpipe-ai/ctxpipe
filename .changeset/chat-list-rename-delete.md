---
"@ctxpipe/aws-cdk": patch
---

Workspace chat list: each chat has a "more" menu with Rename and Delete. Delete asks for confirmation. The backend now refuses to delete a chat while a turn runs in it (409 `turn_running`), so the user stops the turn first.
