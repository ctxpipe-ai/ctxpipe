import { describe, expect, it } from "vitest"
import { selectTouchedScipIndexers } from "./scipTouchedLanguages.js"

const detected = ["go", "typescript", "python", "java"] as const

describe("selectTouchedScipIndexers", () => {
  it("selects only languages represented by changed paths", () => {
    expect(
      selectTouchedScipIndexers(detected, [
        "apps/ui/src/App.tsx",
        "services/api/main.go",
      ]),
    ).toEqual(["go", "typescript"])
  })

  it("recognizes deleted and renamed-path project markers", () => {
    expect(
      selectTouchedScipIndexers(detected, [
        "legacy/requirements.txt",
        "server/build.gradle.kts",
      ]),
    ).toEqual(["python", "java"])
  })

  it("reindexes every detected language when a path is uncertain", () => {
    expect(
      selectTouchedScipIndexers(detected, ["tools/generate.proto"]),
    ).toEqual(detected)
  })

  it("reuses every shard when the partial ingest has no changed paths", () => {
    expect(selectTouchedScipIndexers(detected, [])).toEqual([])
  })

  it("does not select a removed language that is no longer detected", () => {
    expect(selectTouchedScipIndexers(["go"], ["deleted/main.py"])).toEqual([])
  })
})
