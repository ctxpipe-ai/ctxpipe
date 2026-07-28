import { describe, expect, it } from "vitest"
import { kuzuDbPath, scipIndexPath, scipLangShardPath } from "./paths.js"

describe("SCIP repository paths", () => {
  it("keeps legacy Kùzu path until pipeline cutover", () => {
    expect(kuzuDbPath("org_1", "repo_1")).toMatch(
      /\/org_1\/repo_1\/checkouts\/default\.kuzu$/,
    )
  })

  it("places the merged index beside the default checkout", () => {
    expect(scipIndexPath("org_1", "repo_1")).toMatch(
      /\/org_1\/repo_1\/checkouts\/default\.scip$/,
    )
  })

  it("places language shards beside a named checkout", () => {
    expect(
      scipLangShardPath("org_1", "repo_1", "typescript", "checkout_1"),
    ).toMatch(/\/org_1\/repo_1\/checkouts\/checkout_1\.typescript\.scip$/)
  })
})
