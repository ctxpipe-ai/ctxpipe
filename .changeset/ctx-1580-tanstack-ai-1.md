---
"@ctxpipe/aws-cdk": patch
---

improvement: Chat runs on TanStack AI 1.x (CTX-1580). Stored chats load and resume as before. A migration cancels pending chat interrupts that 1.x cannot resume; none are expected.
