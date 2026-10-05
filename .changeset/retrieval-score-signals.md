---
"@ctxpipe/aws-cdk": patch
---

Rank the advisor's graph walk by read-time signals.

- Each edge gets a score from truth (agreeing evidence raises it), authority (ADR status, pull request review), search hits, recency and specificity (hub nodes count less).
- The question's intent (who, why, what changed, what it depends on) gives the relation families it needs more of the budget.
- A pull request now links to each package that it changed (`CHANGED`), so "what changed recently in X" reaches the newest pull requests in one hop. This needs a deterministic-only re-index of the context repository.
- CI runs the live graph tests and a retrieval eval on a synthetic engineering org.
