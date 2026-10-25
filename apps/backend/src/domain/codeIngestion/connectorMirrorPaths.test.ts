import { describe, expect, it } from "vitest"

import {
  connectorMirrorRoot,
  isConnectorMirrorPath,
} from "./connectorMirrorPaths.js"

describe("isConnectorMirrorPath", () => {
  it("matches every connector warehouse prefix", () => {
    expect(isConnectorMirrorPath("github/pulls/acme/api/1--1.md")).toBe(true)
    expect(isConnectorMirrorPath("github/config.yaml")).toBe(true)
    expect(isConnectorMirrorPath("linear/issues/foo--1.md")).toBe(true)
    expect(isConnectorMirrorPath("notion/pages/root--p1/index.md")).toBe(true)
    expect(isConnectorMirrorPath("slack/channels/eng--C1/index.md")).toBe(true)
    expect(isConnectorMirrorPath("confluence/spaces/ENG/page--1.md")).toBe(true)
    expect(isConnectorMirrorPath("pagerduty/incidents/12--P1.md")).toBe(true)
    expect(isConnectorMirrorPath("pagerduty/config.yaml")).toBe(true)
  })

  it("leaves source-repo paths alone", () => {
    expect(isConnectorMirrorPath("AGENTS.md")).toBe(false)
    expect(isConnectorMirrorPath("apps/backend/README.md")).toBe(false)
    expect(isConnectorMirrorPath("docs/github.md")).toBe(false)
  })
})

describe("connectorMirrorRoot", () => {
  it("names the connector of a warehouse path", () => {
    expect(connectorMirrorRoot("github/pulls/acme/api/1--1.md")).toBe("github")
    expect(connectorMirrorRoot("linear/issues/foo--1.md")).toBe("linear")
    expect(connectorMirrorRoot("notion/pages/root--p1/index.md")).toBe("notion")
    expect(connectorMirrorRoot("slack\\channels\\eng--C1\\index.md")).toBe(
      "slack",
    )
    expect(connectorMirrorRoot("confluence/spaces/ENG/page--1.md")).toBe(
      "confluence",
    )
    expect(connectorMirrorRoot("pagerduty/incidents/12--P1.md")).toBe(
      "pagerduty",
    )
  })

  it("returns null for an authored path", () => {
    expect(connectorMirrorRoot("docs/github.md")).toBeNull()
    expect(connectorMirrorRoot("githubby/notes.md")).toBeNull()
  })
})
