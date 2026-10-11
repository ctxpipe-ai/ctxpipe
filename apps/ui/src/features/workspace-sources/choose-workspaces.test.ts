import { describe, expect, it } from "vitest"
import {
  chooseWorkspacesRequests,
  emptyChooseWorkspaces,
} from "./choose-workspaces"

const base = { provider: "linear" as const, connectionId: "con_test1" }

describe("chooseWorkspacesRequests", () => {
  it("is null when no Workspace is selected", () => {
    expect(chooseWorkspacesRequests(emptyChooseWorkspaces(), base)).toBeNull()
  })

  it("gives the shared scope to each selected Workspace", () => {
    const requests = chooseWorkspacesRequests(
      {
        ...emptyChooseWorkspaces(),
        workspaceSlugs: ["docs", "eng"],
        sharedScope: { teams: ["ENG"] },
      },
      base,
    )
    expect(requests).toEqual([
      {
        workspaceSlug: "docs",
        source: { ...base, scope: { teams: ["ENG"] } },
      },
      {
        workspaceSlug: "eng",
        source: { ...base, scope: { teams: ["ENG"] } },
      },
    ])
  })

  it("gives each Workspace its own scope in per-Workspace mode", () => {
    const requests = chooseWorkspacesRequests(
      {
        workspaceSlugs: ["docs", "eng"],
        scopeMode: "per_workspace",
        sharedScope: { teams: ["IGNORED"] },
        scopes: { docs: { teams: ["DOC"] } },
      },
      base,
    )
    expect(requests?.map((r) => r.source.scope)).toEqual([
      { teams: ["DOC"] },
      {},
    ])
  })

  it("is null while one scope editor reports an incomplete scope", () => {
    expect(
      chooseWorkspacesRequests(
        {
          workspaceSlugs: ["docs", "eng"],
          scopeMode: "per_workspace",
          sharedScope: {},
          scopes: { eng: null },
        },
        base,
      ),
    ).toBeNull()
    expect(
      chooseWorkspacesRequests(
        {
          ...emptyChooseWorkspaces(),
          workspaceSlugs: ["docs"],
          sharedScope: null,
        },
        base,
      ),
    ).toBeNull()
  })
})
