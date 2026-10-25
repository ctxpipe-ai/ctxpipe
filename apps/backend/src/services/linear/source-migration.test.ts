import { describe, expect, it } from "vitest"

import { planSourceMigration } from "../../domain/workspace-sources/migration-plan.js"
import { linearLegacyBindings } from "./source-migration.js"

// The shape that the Linear connector setup wrote to linear/config.yaml
// (renderLinearConfigYaml) before ADR-050. Names and ids are made up.
const OLD_CONFIG = `version: 1
source: linear
workspace:
  id: 5f0c1d2e-aaaa-4bbb-8ccc-000000000001
  name: Example Co
scope:
  teams:
    - id: 7a1b2c3d-aaaa-4bbb-8ccc-000000000010
      name: Engineering
      key: ENG
      teamId: 7a1b2c3d-aaaa-4bbb-8ccc-000000000010
      teamKey: ENG
      url: https://linear.app/example/team/ENG
  projects:
    - id: 9e8d7c6b-aaaa-4bbb-8ccc-000000000020
      name: Q3 Launch
      teamId: 7a1b2c3d-aaaa-4bbb-8ccc-000000000010
      teamKey: ENG
      url: https://linear.app/example/project/q3-launch
  documents:
    - id: 1d2e3f4a-aaaa-4bbb-8ccc-000000000030
      name: Release checklist
  initiatives: []
policy:
  customerRequests: exclude
  githubLinks: references_only
`

const input = {
  connectionId: "con_linear1",
  linearWorkspaceId: "5f0c1d2e-aaaa-4bbb-8ccc-000000000001",
  syncRepositoryUrl: "https://github.com/example/context.git",
  configYaml: OLD_CONFIG,
}

describe("linearLegacyBindings", () => {
  it("moves the teams, the projects, and the customer request policy of the old config", () => {
    const bindings = linearLegacyBindings(input)
    expect(bindings).toContainEqual({
      provider: "linear",
      connectionId: "con_linear1",
      syncRepositoryUrl: "https://github.com/example/context.git",
      scope: {
        teams: ["ENG"],
        projects: ["9e8d7c6b-aaaa-4bbb-8ccc-000000000020"],
        customerRequests: "exclude",
      },
    })
  })

  it("reports the documents that do not move", () => {
    expect(linearLegacyBindings(input)).toContainEqual({
      provider: "linear",
      connectionId: "con_linear1",
      unmapped: expect.stringContaining('document "Release checklist"'),
    })
  })

  it("does not map a config of another Linear workspace or a missing file", () => {
    for (const bad of [
      { ...input, linearWorkspaceId: "another-linear-workspace" },
      { ...input, configYaml: undefined },
    ]) {
      const bindings = linearLegacyBindings(bad)
      expect(bindings).toHaveLength(1)
      expect(bindings[0]).toHaveProperty("unmapped")
    }
  })

  it("plans one Linear source in the Workspace whose repository was the sync repository", () => {
    const plan = planSourceMigration({
      workspaces: [
        {
          id: "ws_docs",
          workspaceRepositoryUrl: "https://github.com/example/context",
          githubConnectionId: "con_github1",
          sourcesFile: null,
        },
        {
          id: "ws_other",
          workspaceRepositoryUrl: "https://github.com/example/other",
          githubConnectionId: "con_github1",
          sourcesFile: null,
        },
      ],
      linked: [],
      bindings: linearLegacyBindings(input),
    })
    expect([...plan.changes.keys()]).toEqual(["ws_docs"])
    expect(plan.report.moved).toEqual([
      {
        workspaceId: "ws_docs",
        provider: "linear",
        connectionId: "con_linear1",
      },
    ])
    expect(plan.report.unmapped).toHaveLength(1)
  })
})
