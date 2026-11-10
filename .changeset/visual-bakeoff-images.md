---
---

The bake-off of the visual critic gets each case image from one asset of the release `visual-bakeoff-images`, named by its SHA-256, only when the case runs. The manifest holds the SHA-256 of each image. `pnpm visual:bakeoff:publish` uploads the images. `pnpm visual:bakeoff:queue` fills the labeling queue of the owner in Langfuse, and writes the labels and the picks into `cases.json` (CTX-1201).
