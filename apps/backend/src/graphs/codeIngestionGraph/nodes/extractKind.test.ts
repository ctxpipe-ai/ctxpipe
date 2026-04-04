import { describe, expect, it } from "vitest"
import { listPathsUnderRoot } from "./extractKind.js"

describe("listPathsUnderRoot", () => {
  const paths = [
    "README.md",
    "apps/otel-collector/package.json",
    "apps/otel-collector/Dockerfile",
    "apps/web/index.ts",
  ]

  it("returns all paths for repo root ./", () => {
    expect(listPathsUnderRoot(paths, "./")).toEqual(paths)
  })

  it("returns only paths at or under the workspace root", () => {
    expect(listPathsUnderRoot(paths, "apps/otel-collector")).toEqual([
      "apps/otel-collector/package.json",
      "apps/otel-collector/Dockerfile",
    ])
  })
})
