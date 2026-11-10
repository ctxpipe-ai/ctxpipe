---
---

Add the runner and the report of the visual critic bake-off. `pnpm visual:bakeoff:run` runs each arm (each LLM with three prompt settings, Jev, another decision model, the Jev to LLM cascade, and the local judge of BlazeDiff) on each case, with a spend cap and a fixed hold-out set of 30%. It writes a report with recall, precision, agreement, region overlap, consistency, cost, latency and taste, and selects an arm. The manual workflow `Visual critic bake-off` runs it in the `workbench` environment.
