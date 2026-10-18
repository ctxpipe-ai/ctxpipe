import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  emptyLinearPage,
  installLinearGraphql,
  type LinearGraphqlCall,
  linearBudgetHeaders,
  linearIssueData,
  linearOperationName,
} from "../../../test/linear-graphql.js"
import { useMswServer } from "../../../test/msw.js"
import { parseEnv } from "../../config/env.js"
import {
  syncConnectionSources,
  type WorkspaceSliceWrite,
} from "../../domain/workspace-sources/sync.js"
import { encodeLinearTokensForDb } from "../../lib/connection-config.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { resetLinearGraphqlForTests } from "./graphql.js"
import { linearSourceAdapter } from "./source-adapter.js"
import { linearSourceEventFromPayload } from "./source-event.js"

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

/** Linear answers with a GraphQL error for the matching calls. */
function failCalls(
  matches: (call: LinearGraphqlCall) => boolean,
  answer: { status: number; message: string },
) {
  server.use(
    http.post("https://api.linear.app/graphql", async ({ request }) => {
      const body = (await request.clone().json()) as {
        query?: string
        variables?: Record<string, unknown>
      }
      const call = {
        name: linearOperationName(body.query ?? ""),
        query: body.query ?? "",
        variables: body.variables ?? {},
      }
      if (!matches(call)) return undefined
      calls.push(call)
      return HttpResponse.json(
        {
          data: null,
          errors: [
            {
              message: answer.message,
              extensions:
                answer.status === 200
                  ? { type: "invalid input", code: "INPUT_ERROR" }
                  : { type: "internal error" },
            },
          ],
        },
        { status: answer.status, headers: linearBudgetHeaders() },
      )
    }),
  )
}

const row = (sourceKey: string, scope: Record<string, unknown>) => ({
  sourceKey,
  provider: "linear" as const,
  connectionId: linear,
  scope,
  status: "ok" as const,
  statusDetail: null,
})

const teamCalls = (name = "TeamRecord") =>
  calls.filter((call) => call.name === name).map((call) => call.variables.id)

describe("Linear source adapter on the sync frame (Postgres, msw)", () => {
  let docsWorkspace: string
  let engWorkspace: string
  let opsWorkspace: string
  let revision = 0

  beforeAll(async () => {
    seed = await seedSourcesOrg("linear_src")
    linear = await seed.addConnection("linear", {
      ...encodeLinearTokensForDb(
        { accessToken: "linear-access", refreshToken: null },
        env(),
      ),
      workspaceId: `linear-org-${seed.suffix}`,
      workspaceName: "Example",
      workspaceUrlKey: "example",
      status: "installed",
    })
    docsWorkspace = await seed.addWorkspace("docs")
    engWorkspace = await seed.addWorkspace("eng")
    opsWorkspace = await seed.addWorkspace("ops")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  /** Each test starts from ok rows; a new revision resets a changed status. */
  async function project(ops: Record<string, unknown>) {
    revision += 1
    const at = (n: number) => String(revision * 10 + n).padStart(40, "0")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: docsWorkspace,
      revision: at(1),
      rows: [row("issues", { teams: ["ENG"] })],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: engWorkspace,
      revision: at(2),
      rows: [row("eng-issues", { teams: ["eng"] })],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: opsWorkspace,
      revision: at(3),
      rows: [row("ops-issues", ops)],
    })
  }

  async function sync(
    extra: Partial<Parameters<typeof syncConnectionSources>[0]> = {},
  ) {
    const writes: WorkspaceSliceWrite[] = []
    const result = await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: linear,
      env: env(),
      adapter: linearSourceAdapter,
      write: async (write) => {
        writes.push(write)
      },
      ...extra,
    })
    const byWorkspace = new Map(
      writes.map((write) => [write.workspaceId, write]),
    )
    const paths = (workspaceId: string) =>
      (byWorkspace.get(workspaceId)?.files ?? []).map((file) => file.path)
    return { result, writes, byWorkspace, paths }
  }

  const opsStatus = async () =>
    (
      await listWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId: opsWorkspace,
      })
    )[0]

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
      if (call.name.startsWith("IssueRecord") || call.name === "Issue")
        return {
          issue: linearIssueData({
            id: "issue-team-ops",
            identifier: "OPS-1",
            title: "Changed in Linear",
            teamId: "team-ops",
          }),
        }
      return {}
    })
  })

  it("walks each team one time and writes each Workspace only its own teams and projects", async () => {
    await project({
      teams: ["OPS"],
      projects: ["project-launch"],
      customerRequests: "exclude",
    })
    const { result, byWorkspace, paths } = await sync()
    expect(result.workspaces.sort()).toEqual(
      [docsWorkspace, engWorkspace, opsWorkspace].sort(),
    )
    // Two Workspaces sync ENG, but the walk reads it one time.
    expect(teamCalls()).toEqual(["team-eng", "team-ops"])
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

  it("keeps a hostile issue id from the provider under the team folder", async () => {
    const hostileId = "../../../../.ctxpipe/workspace"
    server.use(
      http.post("https://api.linear.app/graphql", async ({ request }) => {
        const body = (await request.clone().json()) as {
          query?: string
          variables?: Record<string, unknown>
        }
        const name = linearOperationName(body.query ?? "")
        if (!name.startsWith("TeamIssues") || body.variables?.id !== "team-eng")
          return undefined
        return HttpResponse.json(
          {
            data: {
              team: {
                issues: emptyLinearPage([
                  linearIssueData({
                    id: hostileId,
                    identifier: "ENG-1",
                    teamId: "team-eng",
                  }),
                ]),
              },
            },
          },
          { headers: linearBudgetHeaders() },
        )
      }),
    )
    await project({ teams: ["OPS"], customerRequests: "exclude" })
    const { result, paths } = await sync()
    expect(result.workspaces).toContain(engWorkspace)
    const written = paths(engWorkspace)
    expect(written).toContain(
      "linear/teams/eng/issues/eng-1---.-..-..-..-.ctxpipe-workspace.md",
    )
    for (const path of written) {
      expect(path.startsWith("linear/teams/eng/")).toBe(true)
      expect(
        path
          .split("/")
          .some((part) => part === "" || part === "." || part === ".."),
      ).toBe(false)
    }
  })

  it("syncs only the sources that a webhook event touches", async () => {
    await project({ teams: ["OPS"] })
    const { writes } = await sync({
      event: linearSourceEventFromPayload({
        type: "Issue",
        action: "update",
        data: { id: "issue-x", identifier: "OPS-12", projectId: null },
      }),
    })
    expect(writes.map((write) => write.workspaceId)).toEqual([opsWorkspace])
    expect(teamCalls()).toEqual(["team-ops"])
  })

  it("keeps the files of a team that keeps failing, tries it a bounded number of times, and writes the other roots", async () => {
    await project({ teams: ["OPS"], projects: ["project-launch"] })
    failCalls(
      (call) => call.name === "TeamRecord" && call.variables.id === "team-ops",
      { status: 500, message: "Linear is down" },
    )
    const { byWorkspace, paths } = await sync()
    expect(teamCalls().filter((id) => id === "team-ops")).toHaveLength(3)
    expect(paths(docsWorkspace)).toContain(
      "linear/teams/ENG/issues/eng-1--issue-team-eng.md",
    )
    expect(byWorkspace.get(opsWorkspace)).toMatchObject({
      keepPrefixes: ["linear/teams/OPS/"],
    })
    expect(paths(opsWorkspace)).toEqual(
      expect.arrayContaining([
        "linear/projects/project-launch/issues/ops-7--issue-launch.md",
      ]),
    )
    expect(paths(opsWorkspace).some((path) => path.includes("/OPS/"))).toBe(
      false,
    )
    expect((await opsStatus())?.status).toBe("ok")
  })

  it("reports a project that Linear does not have in the source status and keeps its files", async () => {
    await project({ projects: ["project-gone"] })
    failCalls(
      (call) =>
        call.name.startsWith("ProjectRecord") &&
        call.variables.id === "project-gone",
      { status: 200, message: "Entity not found: Project" },
    )
    const { byWorkspace } = await sync()
    expect(
      calls.filter((call) => call.variables.id === "project-gone"),
    ).toHaveLength(1)
    expect(byWorkspace.has(opsWorkspace)).toBe(false)
    expect(await opsStatus()).toMatchObject({
      status: "out_of_access",
      statusDetail: expect.stringContaining("project-gone"),
    })
  })

  it("reports a team key that Linear does not know instead of deleting its files", async () => {
    await project({ teams: ["OPS", "GONE"] })
    const { byWorkspace } = await sync()
    expect(byWorkspace.get(opsWorkspace)).toMatchObject({
      keepPrefixes: ["linear/teams/GONE/"],
    })
    expect(await opsStatus()).toMatchObject({
      status: "out_of_access",
      statusDetail: "The Linear workspace has no team with the key GONE",
    })
  })

  it("sends a patch from the Workspace blobs: unchanged files stay out, and a webhook entity uses the incremental mirror", async () => {
    await project({ teams: ["OPS"] })
    const full = await sync()
    const opsFiles = full.byWorkspace.get(opsWorkspace)?.files ?? []
    const { gitBlobSha } = await import("../connectors/assets.js")
    const blobs = opsFiles.map((file) => ({
      path: file.path,
      sha: gitBlobSha(new TextEncoder().encode(file.content)),
    }))
    calls.length = 0
    const patched = await sync({
      readExisting: async (workspaceId) =>
        workspaceId === opsWorkspace
          ? [
              ...blobs,
              { path: "linear/teams/OPS/issues/old--gone.md", sha: "x" },
            ]
          : [],
      event: linearSourceEventFromPayload(
        {
          type: "Issue",
          action: "update",
          data: { id: "issue-team-ops", identifier: "OPS-1", projectId: null },
        },
        { entityType: "issue", externalId: "issue-team-ops", action: "upsert" },
      ),
    })
    // No full walk: the incremental mirror reads the one issue.
    expect(teamCalls("TeamIssues")).toEqual([])
    const write = patched.byWorkspace.get(opsWorkspace)
    expect(write?.deletePaths).toEqual([])
    expect(write?.files.map((file) => file.path)).toEqual([
      "linear/teams/OPS/issues/ops-1--issue-team-ops.md",
    ])
  })

  it("names the team keys and project ids that Linear does not have, and keeps a scope in reach when Linear cannot answer", async () => {
    failCalls(
      (call) =>
        call.name.startsWith("ProjectRecord") &&
        call.variables.id === "project-gone",
      { status: 200, message: "Entity not found: Project" },
    )
    await expect(
      linearSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: linear,
        env: env(),
        scope: { teams: ["ops", "GONE"], projects: ["project-gone"] },
      }),
    ).resolves.toBe(
      "The Linear workspace has no team with the key GONE; Linear has no project that this connection can read with the id project-gone",
    )
    await expect(
      linearSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: linear,
        env: env(),
        scope: { teams: ["ops"], projects: ["project-launch"] },
      }),
    ).resolves.toBeNull()

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
})
