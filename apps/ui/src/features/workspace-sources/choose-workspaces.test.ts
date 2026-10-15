import { describe, expect, it } from "vitest"
import {
  chooseWorkspacesChanges,
  chooseWorkspacesFromExisting,
  chooseWorkspacesRequests,
  emptyChooseWorkspaces,
  selectWorkspaces,
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
        scopes: { docs: { teams: ["DOC"] }, eng: { teams: ["ENG"] } },
      },
      base,
    )
    expect(requests?.map((r) => r.source.scope)).toEqual([
      { teams: ["DOC"] },
      { teams: ["ENG"] },
    ])
    // A Workspace without a scope starts from {}, which Linear refuses.
    expect(
      chooseWorkspacesRequests(
        {
          workspaceSlugs: ["docs", "eng"],
          scopeMode: "per_workspace",
          sharedScope: null,
          scopes: { docs: { teams: ["DOC"] } },
        },
        base,
      ),
    ).toBeNull()
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

describe("Manage: the step from the existing sources", () => {
  const slack = { provider: "slack" as const, connectionId: "con_slack1" }
  const existing = {
    docs: { path: "slack", scope: { channels: ["C0ENG0001"] } },
    eng: { path: "slack-2", scope: { channels: ["C0OPS0001"] } },
  }

  it("selects one Workspace with its scope", () => {
    expect(chooseWorkspacesFromExisting({ docs: existing.docs })).toEqual({
      workspaceSlugs: ["docs"],
      scopeMode: "shared",
      sharedScope: { channels: ["C0ENG0001"] },
      scopes: { docs: { channels: ["C0ENG0001"] } },
    })
  })

  it("selects more Workspaces with a scope for each", () => {
    expect(chooseWorkspacesFromExisting(existing)).toEqual({
      workspaceSlugs: ["docs", "eng"],
      scopeMode: "per_workspace",
      sharedScope: { channels: ["C0ENG0001"] },
      scopes: {
        docs: { channels: ["C0ENG0001"] },
        eng: { channels: ["C0OPS0001"] },
      },
    })
  })

  it("has no change while the step shows the existing sources", () => {
    expect(
      chooseWorkspacesChanges(
        chooseWorkspacesFromExisting(existing),
        slack,
        existing,
      ),
    ).toEqual([])
  })

  it("ignores the key order of a scope", () => {
    expect(
      chooseWorkspacesChanges(
        {
          ...emptyChooseWorkspaces(),
          workspaceSlugs: ["docs"],
          sharedScope: { teams: ["ENG"], projects: ["p1"] },
        },
        base,
        {
          docs: {
            path: "linear",
            scope: { projects: ["p1"], teams: ["ENG"] },
          },
        },
      ),
    ).toEqual([])
  })

  it("updates a changed scope, removes an unchecked Workspace, and adds a new one", () => {
    expect(
      chooseWorkspacesChanges(
        {
          workspaceSlugs: ["docs", "ops"],
          scopeMode: "per_workspace",
          sharedScope: {},
          scopes: {
            docs: { channels: ["C0ENG0001", "C0NEW0001"] },
            ops: { channels: ["C0OPS0001"] },
          },
        },
        slack,
        existing,
      ),
    ).toEqual([
      {
        kind: "update",
        workspaceSlug: "docs",
        path: "slack",
        source: { ...slack, scope: { channels: ["C0ENG0001", "C0NEW0001"] } },
      },
      {
        kind: "add",
        workspaceSlug: "ops",
        source: { ...slack, scope: { channels: ["C0OPS0001"] } },
      },
      { kind: "remove", workspaceSlug: "eng", path: "slack-2" },
    ])
  })

  it("keeps the scope of the Workspace that stays when the first is unchecked", () => {
    const value = selectWorkspaces(chooseWorkspacesFromExisting(existing), [
      "eng",
    ])
    expect(chooseWorkspacesChanges(value, slack, existing)).toEqual([
      { kind: "remove", workspaceSlug: "docs", path: "slack" },
    ])
  })

  it("removes each source when no Workspace is selected", () => {
    expect(
      chooseWorkspacesChanges(emptyChooseWorkspaces(), slack, existing),
    ).toEqual([
      { kind: "remove", workspaceSlug: "docs", path: "slack" },
      { kind: "remove", workspaceSlug: "eng", path: "slack-2" },
    ])
  })

  it("is null while a selected Workspace has no valid scope", () => {
    expect(
      chooseWorkspacesChanges(
        {
          ...emptyChooseWorkspaces(),
          workspaceSlugs: ["docs"],
          sharedScope: null,
        },
        slack,
        existing,
      ),
    ).toBeNull()
  })
})
