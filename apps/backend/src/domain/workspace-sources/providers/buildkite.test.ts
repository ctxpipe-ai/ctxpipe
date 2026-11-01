import { describe, expect, it } from "vitest"

import { parseSourceEntry, summarizeSourceScope } from "../sources-file.js"
import { buildkiteSourceScope } from "./buildkite.js"

const entry = (scope: Record<string, unknown>) =>
  parseSourceEntry({
    id: "ci",
    provider: "buildkite",
    connection: "con_abc123",
    ...scope,
  })

describe("Buildkite source scope", () => {
  it("accepts a list of pipeline slugs", () => {
    expect(entry({ pipelines: ["deploy"] }).ok).toBe(true)
    expect(entry({ pipelines: ["web-app", "api_tests", "e2e2"] }).ok).toBe(true)
  })

  it.each([
    ["no pipelines", {}],
    ["an empty list", { pipelines: [] }],
    ["a pipeline two times", { pipelines: ["deploy", "deploy"] }],
    ["a path in a slug", { pipelines: ["../deploy"] }],
    ["an organization prefix", { pipelines: ["acme/deploy"] }],
    ["an upper-case slug", { pipelines: ["Deploy"] }],
    ["an object in place of a slug", { pipelines: [{ slug: "deploy" }] }],
    ["an unknown key", { pipelines: ["deploy"], branches: ["main"] }],
  ])("rejects %s", (_name, scope) => {
    expect(entry(scope).ok).toBe(false)
  })

  it("accepts 50 pipelines and rejects 51 with a clear message", () => {
    const slugs = (count: number) =>
      Array.from({ length: count }, (_, index) => `pipeline-${index}`)
    expect(entry({ pipelines: slugs(50) }).ok).toBe(true)
    const result = entry({ pipelines: slugs(51) })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain(
      "Select at most 50 Buildkite pipelines",
    )
  })

  it("summarizes the pipeline count", () => {
    expect(summarizeSourceScope("buildkite", { pipelines: ["deploy"] })).toBe(
      "1 Buildkite pipeline",
    )
    expect(
      buildkiteSourceScope.summarize({ pipelines: ["deploy", "web-app"] }),
    ).toBe("2 Buildkite pipelines")
  })
})
