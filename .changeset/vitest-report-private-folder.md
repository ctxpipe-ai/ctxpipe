---
---

The check runner writes the Vitest report of a lane to a temporary folder of that run. The rerun of failed checks writes its logs to its own folder (`run.mjs --logs`) and does not move `.ci-results/checks` (CTX-1411).
