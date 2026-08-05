import { describe, expect, it } from "vitest"
import {
  hasSlackConfigYamlChanged,
  parseSlackConfigYamlContent,
  renderSlackConfigYaml,
} from "./config-yaml.js"

const eng = { channelId: "C2", name: "eng", isPrivate: false }
const leadership = { channelId: "C1", name: "leadership", isPrivate: true }

describe("Slack config YAML", () => {
  it("renders channels in a stable order", () => {
    expect(
      renderSlackConfigYaml({
        teamId: "T1",
        oldestDays: 90,
        channels: [eng, leadership],
      }),
    ).toBe(
      renderSlackConfigYaml({
        teamId: "T1",
        oldestDays: 90,
        channels: [leadership, eng],
      }),
    )
  })

  it("does not treat channel ordering as a scope change", () => {
    const current = renderSlackConfigYaml({
      teamId: "T1",
      oldestDays: 90,
      channels: [eng, leadership],
    })
    const next = renderSlackConfigYaml({
      teamId: "T1",
      oldestDays: 90,
      channels: [leadership, eng],
    })
    expect(hasSlackConfigYamlChanged({ current, next })).toBe(false)
  })

  it("detects a changed channel selection", () => {
    const current = renderSlackConfigYaml({
      oldestDays: 90,
      channels: [eng],
    })
    const next = renderSlackConfigYaml({
      oldestDays: 90,
      channels: [eng, leadership],
    })
    expect(hasSlackConfigYamlChanged({ current, next })).toBe(true)
  })

  it("parses retention and private flags", () => {
    const parsed = parseSlackConfigYamlContent(
      [
        "version: 1",
        "source: slack",
        "teamId: T1",
        "retention:",
        "  oldestDays: 30",
        "channels:",
        "  - id: C1",
        "    name: leadership",
        "    isPrivate: true",
        "",
      ].join("\n"),
    )
    expect(parsed).toEqual({
      teamId: "T1",
      oldestDays: 30,
      channels: [
        { channelId: "C1", name: "leadership", isPrivate: true },
      ],
    })
  })
})
