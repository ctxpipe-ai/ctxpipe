import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { resolveIngestionV2Run } from "./ingestion-v2-resolve.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

describe("resolveIngestionV2Run: the publish gate (format 3)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("ingest_gate")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  /** A writable Workspace that declares `repository`, at the cached `formatVersion`. */
  async function addDeclaringWorkspace(input: {
    slug: string
    repository: string
    formatVersion: number | null
  }) {
    const github = await seed.addConnection("github")
    const id = await seed.addWorkspace(input.slug)
    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({
          githubConnectionId: github,
          desiredSha: "a".repeat(40),
          writeStatus: "writable",
          formatVersion: input.formatVersion,
        })
        .where(eq(workspaces.id, id)),
    )
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: id,
      revision: "a".repeat(40),
      rows: [
        {
          sourceKey: "sources/github/acme/checkout.md",
          provider: "github",
          connectionId: github,
          scope: { repositories: [input.repository] },
          status: "ok",
          statusDetail: null,
        },
      ],
    })
    return id
  }

  const resolve = (shadow: boolean, repository: string) =>
    withOrgIdContext({ id: seed.orgId, slug: seed.orgId }, () =>
      resolveIngestionV2Run({
        orgId: seed.orgId,
        shadow,
        source: {
          kind: "github" as const,
          url: `https://github.com/${repository}`,
          githubConnectionId: "con_unused",
        },
      }),
    )

  it("publishes only to a Workspace at format 3 or more, and names the one that waits", async () => {
    const repository = `acme/api-${seed.suffix.replaceAll("_", "-")}`
    const old = await addDeclaringWorkspace({
      slug: "old",
      repository,
      formatVersion: 2,
    })
    const current = await addDeclaringWorkspace({
      slug: "current",
      repository,
      formatVersion: 3,
    })
    const resolved = await resolve(false, repository)
    if (resolved.skipped) throw new Error(`skipped: ${resolved.skipped}`)
    expect(resolved.destinations.map((d) => d.workspaceId)).toEqual([current])
    expect(resolved.needsUpgrade).toEqual([old])
  })

  it("skips with a reason when each declaring Workspace is below format 3", async () => {
    const repository = `acme/solo-${seed.suffix.replaceAll("_", "-")}`
    await addDeclaringWorkspace({ slug: "solo", repository, formatVersion: 0 })
    expect(await resolve(false, repository)).toEqual({
      skipped: "upgrade_needed",
    })
  })

  it("lets a shadow run read each Workspace, because it publishes nothing", async () => {
    const repository = `acme/shadow-${seed.suffix.replaceAll("_", "-")}`
    const id = await addDeclaringWorkspace({
      slug: "shadow",
      repository,
      formatVersion: 1,
    })
    const resolved = await resolve(true, repository)
    if (resolved.skipped) throw new Error(`skipped: ${resolved.skipped}`)
    expect(resolved.destinations.map((d) => d.workspaceId)).toEqual([id])
    expect(resolved.needsUpgrade).toEqual([])
  })
})
