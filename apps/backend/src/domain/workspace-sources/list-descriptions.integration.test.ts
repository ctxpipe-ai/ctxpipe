import { afterAll, beforeAll, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { listWorkspaceSources } from "./service.js"
import { SOURCE_FILE_MAX_BYTES } from "./source-file.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
beforeAll(async () => {
  seed = await seedSourcesOrg("wsrc_desc")
})
afterAll(async () => {
  await seed.cleanup()
})

it("lists the body of each source file from git at the served revision", async () => {
  const linear = await seed.addConnection("linear")
  const repo = await seed.gitRepository()
  const workspaceId = await seed.addWorkspace("desc", repo.dir)
  const file = (body: string) =>
    `---\nprovider: linear\nconnection: ${linear}\nteams: [ENG]\n---\n${body}`
  const sha = await repo.commit({
    "sources/linear/eng.md": file("Engineering issues.\n"),
    "sources/linear/none.md": file(""),
    "sources/linear/huge.md": file(`${"x".repeat(SOURCE_FILE_MAX_BYTES)}\n`),
  })
  const row = (path: string) => ({
    sourceKey: path,
    provider: "linear" as const,
    connectionId: linear,
    scope: { teams: ["ENG"] },
    status: "ok" as const,
    statusDetail: null,
  })
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId,
    revision: sha,
    rows: ["eng", "none", "huge"].map((n) => row(`sources/linear/${n}.md`)),
  })

  const list = await withOrgIdContext({ id: seed.orgId } as never, async () => {
    const workspace = await getWorkspaceById(workspaceId)
    if (!workspace) throw new Error("missing Workspace")
    return listWorkspaceSources(workspace)
  })

  const byPath = Object.fromEntries(list.items.map((i) => [i.path, i]))
  expect(byPath["sources/linear/eng.md"]?.description).toBe(
    "Engineering issues.",
  )
  expect(byPath["sources/linear/none.md"]?.description).toBeUndefined()
  expect(byPath["sources/linear/huge.md"]?.description).toBeUndefined()
})
