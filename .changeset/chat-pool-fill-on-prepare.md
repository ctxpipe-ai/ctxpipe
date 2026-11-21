---
"@ctxpipe/aws-cdk": patch
---

A chat prepare now starts the warm pool fill, as a turn does (ADR-061 decision 18). The fill ran only from the TanStack `onReady` hook, which runs only in a turn. On production, every conversation start was a prepare with no turn after it in the next minutes, so the pool never filled (CTX-1323).
