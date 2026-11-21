---
"@ctxpipe/aws-cdk": minor
---

Chat: a new conversation starts from a base branch that you pick in the composer. Its session branch starts from that branch, each turn rebases on it, and its pull request targets it. The graph tools of the chat read the session branch when it has a knowledge projection. The API adds `GET /workspaces/{slug}/branches` and an optional `baseBranch` on the conversation; the migration adds the nullable column `conversations.base_branch` (ADR-071, CTX-1457).
