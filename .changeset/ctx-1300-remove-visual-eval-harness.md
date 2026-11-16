---
---

Remove the eval harness of the visual critic (`packages/visual-review/evals/`), the `visual:bakeoff:*` scripts and the manual workflow `visual-bakeoff.yaml`. The evals are now private tooling of the factory: they run on the host with `factory eval`, never in CI (CTX-1300).
