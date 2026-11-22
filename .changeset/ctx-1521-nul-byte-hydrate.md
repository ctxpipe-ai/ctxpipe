---
---

The hydrate removes each NUL character from the unit text before it writes Postgres, so a mirrored issue body with a NUL character does not fail the hydrate (CTX-1521).
