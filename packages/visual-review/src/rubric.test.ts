import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { areas, qualities } from "./index.ts"

const root = fileURLToPath(new URL("../../../", import.meta.url))

describe("rubric", () => {
  test("has the seven concrete areas and the ten design qualities", () => {
    expect(areas.map(({ name }) => name)).toEqual([
      "Spacing",
      "Color tokens",
      "Typography",
      "Overflow and truncation",
      "Contrast",
      "Alignment",
      "Missing elements",
    ])
    expect(qualities.map(({ name }) => name)).toEqual([
      "Clarity",
      "Hierarchy",
      "Focus",
      "Consistency",
      "Grouping and rhythm",
      "Density",
      "Feedback and state",
      "Accessibility",
      "Restraint",
      "Brand fit",
    ])
    expect(
      qualities.filter(({ pageOnly }) => pageOnly).map(({ id }) => id),
    ).toEqual(["focus"])
  })

  test("each entry cites a section that exists in our design docs", () => {
    const missing = [...areas, ...qualities].flatMap(({ id, sources }) =>
      sources
        .filter(({ file, section }) => {
          const headings = readFileSync(`${root}${file}`, "utf8")
            .split("\n")
            .filter((line) => /^#{2,4} /.test(line))
            .map((line) => line.replace(/^#+ /, "").trim())
          return !headings.includes(section)
        })
        .map(({ file, section }) => `${id}: ${file} › ${section}`),
    )

    expect(missing).toEqual([])
  })
})
