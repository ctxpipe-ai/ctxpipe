---
---

Internal: a semantic merge that loses the push race waits longer before each new attempt, up to 8 attempts, so that a burst of connector mirror writes ends first (CTX-1304).
