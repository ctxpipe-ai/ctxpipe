import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

/**
 * Before any test file starts, the `converter` prerequisite builds the file
 * converter that the knowledge-plane tests run, so that no test waits for a
 * build. Cargo reuses a current build. In CI the job step restores or builds
 * it and sets SKIP_CONVERTER_BUILD=1, so this only checks that it runs.
 */
export default function setup(): void {
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
}
