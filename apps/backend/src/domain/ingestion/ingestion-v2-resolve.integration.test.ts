import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { githubSourcePathsByRepository } from "../workspace-sources/github-sources.js"
import { projectWorkspaceSources } from "../workspace-sources/project.js"
import { resolveIngestionV2Run } from "./ingestion-v2-resolve.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

describe("the source path of a repository (Postgres + git)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("v2_resolve")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("gives the ownership migration and the ingestion v2 run the winner of the projection", async () => {
    const env = parseEnv(process.env)
    // No installation: the access check finds no coverage and asks no API.
    const github = await seed.addConnection("github")
    const workspaceId = await seed.addWorkspace("resolve")
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({
          githubConnectionId: github,
          writeStatus: "writable",
          desiredSha: "a".repeat(40),
        })
        .where(eq(workspaces.id, workspaceId)),
    )
    const repo = await seed.gitRepository()
    const repository = `acme/billing-${seed.suffix.replaceAll("_", "-")}`
    const text = `---\nprovider: github\nconnection: ${github}\nrepository: ${repository}\n---\n`
    const project = async (files: Record<string, string>) => {
      const revision = await repo.commit(files)
      const tree = await repo.sourcesTree(revision)
      await withOrgIdContext({ id: seed.orgId, slug: seed.orgId }, () =>
        projectWorkspaceSources({
          orgId: seed.orgId,
          workspaceId,
          revision,
          text: tree.sourcesFile,
          files: tree.sourceFiles,
          env,
        }),
      )
      return tree.sourceFiles
    }

    await project({ "sources/github/acme/b.md": text })
    // `a.md` comes first in byte order, but `b.md` linked the repository.
    const sourceFiles = await project({ "sources/github/acme/a.md": text })

    const migration = githubSourcePathsByRepository(
      sourceFiles,
      await listWorkspaceSourceRows({ orgId: seed.orgId, workspaceId }),
    )
    expect(migration.get(`https://github.com/${repository}`)).toBe(
      "sources/github/acme/b.md",
    )
    const run = await resolveIngestionV2Run({
      orgId: seed.orgId,
      source: {
        url: `https://github.com/${repository}`,
        githubConnectionId: github,
      },
    })
    expect(
      run.skipped ? run.skipped : run.destinations.map((d) => d.sourcePath),
    ).toEqual(["sources/github/acme/b.md"])
  })
})
