import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Codesearch keeps its own copy of `secretPath.ts` because no shared workspace
 * package fits. The check lives here because codesearch tests run in a Docker
 * image that only contains `apps/codesearch`.
 */
function implementation(source: string): string {
  const start = source.indexOf("const SECRET_PATH_RULES")
  if (start < 0) throw new Error("SECRET_PATH_RULES missing")
  return source.slice(start).trim()
}

describe("secretPath parity with the codesearch copy", () => {
  it("keeps the rule table and redaction functions identical", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const backend = readFileSync(resolve(here, "secretPath.ts"), "utf8")
    const codesearch = readFileSync(
      resolve(here, "../../../codesearch/src/observability/secretPath.ts"),
      "utf8",
    )
    expect(implementation(codesearch)).toBe(implementation(backend))
  })
})
