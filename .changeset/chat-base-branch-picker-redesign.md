---
"@ctxpipe/aws-cdk": patch
---

improvement: Chat: when the org's `knowledge_plane` flag is not `off`, the base branch of a new conversation is a quiet branch control in the composer footer, with a menu that has a search field. The control shows the default branch at once; only the menu waits for the branch list. After the first message, the conversation header names the base branch and the session branch as plain text. The suggested prompts are a centered row of short pills under the composer; a pill puts its full prompt in the composer. The Workspace API adds `defaultBranch`, and the Workspace list adds the org's `knowledgePlane` flag (CTX-1468).
