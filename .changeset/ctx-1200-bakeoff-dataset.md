---
---

Add the dataset builder of the visual critic bake-off. `pnpm visual:bakeoff:build` renders real changes from the git history, synthetic regressions with a known region, noise, and mixed cases in the pinned capture container. It writes the images to `.ci-results/visual-bakeoff/` and the case manifest to `packages/visual-review/evals/critic/cases.json`.
