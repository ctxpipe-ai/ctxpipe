import { describe, expect, it } from "vitest"
import {
  hasNotionConfigYamlChanged,
  notionResourcesEqual,
  renderNotionConfigYaml,
} from "./config-yaml.js"

const people = {
  externalId: "page-2",
  type: "database" as const,
  title: "People",
}
const handbook = {
  externalId: "page-1",
  type: "page" as const,
  title: "Handbook",
}

describe("Notion config YAML", () => {
  it("renders resources in a stable order", () => {
    expect(renderNotionConfigYaml({ resources: [people, handbook] })).toBe(
      renderNotionConfigYaml({ resources: [handbook, people] }),
    )
  })

  it("does not treat resource ordering as a scope change", () => {
    const current = [
      "version: 1",
      "source: notion",
      "resources:",
      "  - id: page-1",
      "    type: page",
      "    title: Handbook",
      "  - id: page-2",
      "    type: database",
      "    title: People",
      "",
    ].join("\n")
    const next = renderNotionConfigYaml({ resources: [people, handbook] })

    expect(hasNotionConfigYamlChanged({ current, next })).toBe(false)
  })

  it("detects a changed resource selection", () => {
    const current = renderNotionConfigYaml({ resources: [handbook] })
    const next = renderNotionConfigYaml({ resources: [handbook, people] })

    expect(hasNotionConfigYamlChanged({ current, next })).toBe(true)
  })

  it("detects a config version change", () => {
    const current = renderNotionConfigYaml({ resources: [handbook] })
    const next = current.replace("version: 1", "version: 2")

    expect(hasNotionConfigYamlChanged({ current, next })).toBe(true)
  })
})

describe("notionResourcesEqual", () => {
  it("treats the same selection in a different order as equal", () => {
    expect(notionResourcesEqual([handbook, people], [people, handbook])).toBe(
      true,
    )
  })

  it("ignores metadata that is not persisted to git", () => {
    expect(
      notionResourcesEqual(
        [
          {
            ...handbook,
            url: "https://notion.so/page-1",
            parentExternalId: "x",
          },
        ],
        [handbook],
      ),
    ).toBe(true)
  })

  it("detects a changed title", () => {
    expect(
      notionResourcesEqual([handbook], [{ ...handbook, title: "Playbook" }]),
    ).toBe(false)
  })

  it("detects a changed selection", () => {
    expect(notionResourcesEqual([handbook], [handbook, people])).toBe(false)
  })
})
