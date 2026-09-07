import baseline from "../../../apps/backend/vitest.config.ts"

// Execute the two excluded files explicitly while retaining production test setup.
export default {
  ...baseline,
  root: new URL("../../../apps/backend/", import.meta.url).pathname,
  test: { ...baseline.test, exclude: [] },
}
