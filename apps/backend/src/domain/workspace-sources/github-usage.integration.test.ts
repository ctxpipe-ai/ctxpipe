import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { repositoryKeyFromGitUrl } from "../workspaces/slug.js"
import { listConnectionUsage } from "./service.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

beforeAll(async () => {
  seed = await seedSourcesOrg("wsrc_github_usage")
})
afterAll(async () => {
  await withOrgDbContext(seed.orgId, (db) =>
    db.delete(repositories).where(eq(repositories.orgId, seed.orgId)),
  )
  await seed.cleanup()
})

it("counts the Workspace repository and the linked repositories that use a GitHub connection", async () => {
  const github = await seed.addConnection("github", { installationId: 4242 })
  const other = await seed.addConnection("github", { installationId: 4343 })
  const owner = await seed.addWorkspace("owner")
  const linker = await seed.addWorkspace("linker")
  await seed.addWorkspace("unrelated")
  await withOrgDbContext(seed.orgId, async (db) => {
    await db
      .update(workspaces)
      .set({ githubConnectionId: github })
      .where(eq(workspaces.id, owner))
    const repository = async (name: string, connectionId: string | null) => {
      const gitUrl = `https://github.com/acme/${name}`
      await db.insert(repositories).values({
        id: `repo_${name}_${seed.suffix}`,
        orgId: seed.orgId,
        name: `acme/${name}`,
        gitUrl,
        repositoryKey: repositoryKeyFromGitUrl(gitUrl),
        githubConnectionId: connectionId,
      })
      return gitUrl
    }
    const web = await repository(`web-${seed.suffix}`, github)
    const api = await repository(`api-${seed.suffix}`, github)
    const foreign = await repository(`foreign-${seed.suffix}`, other)
    const link = (workspaceId: string, gitUrl: string) =>
      db.insert(workspaceLinkedRepositories).values({
        id: `wlr_${Math.random().toString(36).slice(2)}`,
        orgId: seed.orgId,
        workspaceId,
        gitUrl,
      })
    await link(owner, web)
    await link(owner, api)
    await link(owner, foreign)
    await link(linker, web)
  })

  // The route runs in a request; its logger records a failed pull request
  // lookup (this test has no GitHub).
  const usage = await withLogger(createLogger({}), () =>
    withOrgIdContext({ id: seed.orgId, slug: seed.orgId }, () =>
      listConnectionUsage(github),
    ),
  )

  expect(
    usage?.items
      .map((item) => ({ workspaceId: item.workspaceId, stat: item.stat }))
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  ).toEqual(
    [
      {
        workspaceId: owner,
        stat: "Workspace repository · 2 linked repositories",
      },
      { workspaceId: linker, stat: "1 linked repository" },
    ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  )
})
