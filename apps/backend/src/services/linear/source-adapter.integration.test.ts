import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  emptyLinearPage,
  installLinearGraphql,
  type LinearGraphqlCall,
  linearIssueData,
} from "../../../test/linear-graphql.js"
import { useMswServer } from "../../../test/msw.js"
import { parseEnv } from "../../config/env.js"
import {
  syncConnectionSources,
  type WorkspaceSliceWrite,
} from "../../domain/workspace-sources/sync.js"
import { encodeLinearTokensForDb } from "../../lib/connection-config.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { resetLinearGraphqlForTests } from "./graphql.js"
import {
  linearSourceAdapter,
  linearSourceEventFromPayload,
} from "./source-adapter.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const calls: LinearGraphqlCall[] = []
let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let linear: string
const env = () => parseEnv(process.env)

const teams: Record<string, { key: string; name: string }> = {
  "team-eng": { key: "ENG", name: "Engineering" },
  "team-ops": { key: "OPS", name: "Operations" },
}

function teamRecord(id: string) {
  return {
    id,
    name: teams[id]?.name ?? id,
    key: teams[id]?.key ?? id,
    description: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    parent: null,
  }
}

function projectNode(id: string) {
  return {
    id,
    name: "Launch",
    url: `https://linear.app/example/project/${id}`,
    content: "Project body",
    description: "Launch",
    priorityLabel: "High",
    progress: 0,
    startDate: null,
    targetDate: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    status: { id: "status-1" },
    lead: null,
    teams: emptyLinearPage([{ id: "team-ops" }]),
    projectUpdates: emptyLinearPage(),
    documents: emptyLinearPage(),
    needs: emptyLinearPage(),
  }
}

const row = (sourceKey: string, scope: Record<string, unknown>) => ({
  sourceKey,
  provider: "linear" as const,
  connectionId: linear,
  scope,
  status: "ok" as const,
  statusDetail: null,
})

describe("Linear source adapter on the sync frame (Postgres, msw)", () => {
  let docsWorkspace: string
  let engWorkspace: string
  let opsWorkspace: string

  beforeAll(async () => {
    seed = await seedSourcesOrg("linear_src")
    linear = await seed.addConnection("linear", {
      ...encodeLinearTokensForDb(
        { accessToken: "linear-access", refreshToken: null },
        env(),
      ),
      workspaceId: "linear-org-1",
      workspaceName: "Example",
      workspaceUrlKey: "example",
      status: "installed",
    })
    docsWorkspace = await seed.addWorkspace("docs")
    engWorkspace = await seed.addWorkspace("eng")
    opsWorkspace = await seed.addWorkspace("ops")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: docsWorkspace,
      revision: "a".repeat(40),
      rows: [row("issues", { teams: ["ENG"], projects: [] })],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: engWorkspace,
      revision: "b".repeat(40),
      rows: [row("eng-issues", { teams: ["eng"], projects: [] })],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: opsWorkspace,
      revision: "c".repeat(40),
      rows: [
        row("ops-issues", {
          teams: ["OPS", "GONE"],
          projects: ["project-launch"],
          customerRequests: "exclude",
        }),
      ],
    })
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  beforeEach(() => {
    resetLinearGraphqlForTests()
    calls.length = 0
    installLinearGraphql(server, calls, (call) => {
      const id = String(call.variables.id ?? "")
      if (call.name === "DiscoverScopes")
        return {
          teams: emptyLinearPage(
            Object.entries(teams).map(([teamId, team]) => ({
              id: teamId,
              ...team,
            })),
          ),
        }
      if (call.name === "TeamRecord") return { team: teamRecord(id) }
      if (call.name.startsWith("TeamIssues"))
        return {
          team: {
            issues: emptyLinearPage([
              linearIssueData({
                id: `issue-${id}`,
                identifier: `${teams[id]?.key ?? "X"}-1`,
                teamId: id,
              }),
            ]),
          },
        }
      if (call.name.startsWith("TeamProjects"))
        return { team: { projects: emptyLinearPage() } }
      if (call.name === "TeamCycles")
        return { team: { cycles: emptyLinearPage() } }
      if (call.name === "TeamLabels")
        return { team: { labels: emptyLinearPage() } }
      if (call.name.startsWith("ProjectRecord"))
        return { project: projectNode(id) }
      if (call.name.startsWith("ProjectIssues"))
        return {
          project: {
            issues: emptyLinearPage([
              linearIssueData({ id: "issue-launch", identifier: "OPS-7" }),
            ]),
          },
        }
      return {}
    })
  })

  it("walks each team one time and writes each Workspace only its own teams and projects", async () => {
    const writes: WorkspaceSliceWrite[] = []
    const result = await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: linear,
      env: env(),
      adapter: linearSourceAdapter,
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(result.workspaces.sort()).toEqual(
      [docsWorkspace, engWorkspace, opsWorkspace].sort(),
    )
    // Two Workspaces sync ENG, but the walk reads it one time.
    expect(
      calls
        .filter((call) => call.name === "TeamRecord")
        .map((c) => c.variables.id),
    ).toEqual(["team-eng", "team-ops"])

    const byWorkspace = new Map(
      writes.map((write) => [write.workspaceId, write]),
    )
    const paths = (workspaceId: string) =>
      (byWorkspace.get(workspaceId)?.files ?? []).map((file) => file.path)

    // The same team under two spellings of its key: one walk, two roots.
    for (const [workspaceId, key] of [
      [docsWorkspace, "ENG"],
      [engWorkspace, "eng"],
    ] as const) {
      expect(byWorkspace.get(workspaceId)?.ownedPrefixes).toEqual([
        `linear/teams/${key}/`,
      ])
      expect(paths(workspaceId)).toContain(
        `linear/teams/${key}/issues/eng-1--issue-team-eng.md`,
      )
      expect(
        paths(workspaceId).every((path) =>
          path.startsWith(`linear/teams/${key}/`),
        ),
      ).toBe(true)
    }
    // GONE is not a team of the Linear workspace: it owns its path, but
    // gets no files, so a removed team's files go away.
    expect(byWorkspace.get(opsWorkspace)?.ownedPrefixes).toEqual([
      "linear/projects/project-launch/",
      "linear/teams/GONE/",
      "linear/teams/OPS/",
    ])
    expect(paths(opsWorkspace)).toEqual(
      expect.arrayContaining([
        "linear/teams/OPS/issues/ops-1--issue-team-ops.md",
        "linear/projects/project-launch/issues/ops-7--issue-launch.md",
      ]),
    )
    expect(paths(opsWorkspace).some((path) => path.includes("ENG"))).toBe(false)
    // The ops source excludes customer requests, so its walk does not ask.
    expect(
      calls.some(
        (call) =>
          call.name.endsWith("WithNeeds") && call.variables.id === "team-ops",
      ),
    ).toBe(false)
  })

  it("names a team key that the Linear workspace does not have", async () => {
    await expect(
      linearSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: linear,
        env: env(),
        scope: { teams: ["OPS", "GONE"], projects: [] },
      }),
    ).resolves.toBe("The Linear workspace has no team with the key GONE")
    await expect(
      linearSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: linear,
        env: env(),
        scope: { teams: ["ops"], projects: [] },
      }),
    ).resolves.toBeNull()
  })

  it("keeps a scope in reach when Linear cannot answer the access check", async () => {
    resetLinearGraphqlForTests()
    installLinearGraphql(server, calls, () => ({}), { status: 500 })
    await expect(
      linearSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: linear,
        env: env(),
        scope: { teams: ["GONE"] },
      }),
    ).resolves.toBeNull()
  })

  it("syncs only the sources that a webhook event touches", async () => {
    const writes: WorkspaceSliceWrite[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: linear,
      env: env(),
      adapter: linearSourceAdapter,
      event: linearSourceEventFromPayload({
        type: "Issue",
        action: "update",
        data: { id: "issue-x", identifier: "OPS-12", teamId: "team-ops" },
      }),
      write: async (write) => {
        writes.push(write)
      },
    })
    expect(writes.map((write) => write.workspaceId)).toEqual([opsWorkspace])
    expect(
      calls
        .filter((call) => call.name === "TeamRecord")
        .map((c) => c.variables.id),
    ).toEqual(["team-ops"])
  })

  it("does not write when a Linear page fails, so no file is deleted", async () => {
    resetLinearGraphqlForTests()
    installLinearGraphql(server, calls, () => ({}), { status: 500 })
    const writes: WorkspaceSliceWrite[] = []
    await expect(
      syncConnectionSources({
        orgId: seed.orgId,
        connectionId: linear,
        env: env(),
        adapter: linearSourceAdapter,
        write: async (write) => {
          writes.push(write)
        },
      }),
    ).rejects.toThrow()
    expect(writes).toEqual([])
  })
})
