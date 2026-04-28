import { describe, expect, it } from "vitest"
import {
  parseConfluenceConfigYamlContent,
  renderConfluenceConfigYaml,
} from "./config-yaml.js"

describe("parseConfluenceConfigYamlContent", () => {
  it("parses round-tripped YAML", () => {
    const yaml = renderConfluenceConfigYaml({
      spaces: [
        { spaceKey: "ENG", selectedPageIds: ["1", "2"] },
        { spaceKey: "DOC", selectedPageIds: null },
      ],
    })
    const parsed = parseConfluenceConfigYamlContent(yaml)
    expect(parsed?.spaces).toEqual([
      { spaceKey: "ENG", selectedPageIds: ["1", "2"] },
      { spaceKey: "DOC", selectedPageIds: [] },
    ])
  })

  it("returns undefined for invalid YAML content", () => {
    expect(parseConfluenceConfigYamlContent("not: yaml: [[[")).toBeUndefined()
  })
})
