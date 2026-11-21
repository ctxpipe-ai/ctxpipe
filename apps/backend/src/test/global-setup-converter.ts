import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { scrubForModel } from "../retrieval/services/scrubForModel.js"

/**
 * Before any test file starts, the `converter` prerequisite builds the file
 * converter that the knowledge-plane tests run, and the secret scrubber of
 * every model call (ADR-072), so that no test waits for a build. Cargo
 * reuses a current build. In CI the job step restores or builds it and sets
 * SKIP_CONVERTER_BUILD=1, so this only checks that it runs.
 */
export default async function setup(): Promise<void> {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../../../../scripts/checks/prerequisites.mjs",
          import.meta.url,
        ),
      ),
      "converter",
    ],
    // The result line, and the fix of a failure, go to stderr.
    { stdio: ["ignore", 2, "inherit"] },
  )
  // The secret scrubber of the converter compiles its rules once (about
  // 3 s) and keeps them in its cache. Then the first model call of a test
  // file waits about 0.3 s, not 3 s.
  await scrubForModel("")
}
