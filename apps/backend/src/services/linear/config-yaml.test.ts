import { describe, expect, it } from "vitest"
import {
  hasLinearConfigYamlChanged,
  parseLinearConfigYamlContent,
  renderLinearConfigYaml,
} from "./config-yaml.js"

const team = {
  externalId: "team-1",
  type: "team" as const,
  title: "Product",
  url: "https://linear.app/acme/team/PRO",
  parentExternalId: null,
  teamId: "team-1",
  teamKey: "PRO",
}
const project = {
  externalId: "project-1",
  type: "project" as const,
  title: "Launch",
  url: "https://linear.app/acme/project/launch",
  parentExternalId: "team-1",
  teamId: "team-1",
  teamKey: "PRO",
}

describe("Linear config YAML", () => {
  it("round-trips stable scope identity and privacy policy", () => {
    const rendered = renderLinearConfigYaml({
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      scopes: [project, team],
      customerRequests: "limited",
    })

    expect(parseLinearConfigYamlContent(rendered)).toEqual({
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      customerRequests: "limited",
      scopes: [project, team],
    })
    expect(rendered).toContain("githubLinks: references_only")
    expect(rendered).toContain("attachmentBinaries: false")
  })

  it("compares semantic content rather than YAML formatting or ordering", () => {
    const first = renderLinearConfigYaml({
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      scopes: [team, project],
    })
    const second = renderLinearConfigYaml({
      workspaceId: "workspace-1",
      workspaceName: "Acme",
      scopes: [project, team],
    })
    expect(hasLinearConfigYamlChanged({ current: first, next: second })).toBe(
      false,
    )
  })

  it("rejects malformed, cross-source, and duplicate scope config", () => {
    expect(parseLinearConfigYamlContent("source: slack")).toBeUndefined()
    expect(
      parseLinearConfigYamlContent(`
version: 1
source: linear
workspace: { id: workspace-1, name: Acme }
scope:
  teams:
    - { id: team-1, name: Product }
    - { id: team-1, name: Duplicate }
`),
    ).toBeUndefined()
  })
})
