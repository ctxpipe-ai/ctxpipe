---
---

The knowledge search's full-text side uses its GIN index again for the app role. Row-level security had kept Postgres from using it, so each search read every chunk of its scope.
