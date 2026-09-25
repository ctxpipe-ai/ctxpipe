import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Codesearch keeps its own copies of these modules because no shared workspace
 * package fits. The check lives here because codesearch tests run in a Docker
 * image that only contains `apps/codesearch`.
 */
const here = dirname(fileURLToPath(import.meta.url))
const read = (app: "backend" | "codesearch", file: string) =>
  readFileSync(
    resolve(here, `../../../${app}/src/observability/${file}`),
    "utf8",
  )

describe("observability modules copied into codesearch", () => {
  it.each([
    "dbTrace.ts",
    "scrubDbError.ts",
    "flushOnDemandMetricReader.ts",
  ])("keeps %s identical", (file) => {
    expect(read("codesearch", file)).toBe(read("backend", file))
  })

  it("keeps the secretPath rule table and redaction functions identical", () => {
    const implementation = (source: string) => {
      const start = source.indexOf("const SECRET_PATH_RULES")
      if (start < 0) throw new Error("SECRET_PATH_RULES missing")
      return source.slice(start).trim()
    }
    expect(implementation(read("codesearch", "secretPath.ts"))).toBe(
      implementation(read("backend", "secretPath.ts")),
    )
  })
})
