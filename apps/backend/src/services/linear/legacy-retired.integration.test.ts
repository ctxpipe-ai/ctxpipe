import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { linearLegacySyncRetired } from "./legacy-retired.js"
import { linearSourceMigrationHook } from "./source-migration.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let repositoryId: string
let gitUrl: string

/** A Linear connection with a legacy binding to the old sync repository. */
const legacyConfig = (setupPhase: string) => ({
  status: "installed",
  workspaceId: `linear-org-${seed.suffix}`,
  workspaceName: "Example",
  repositoryId,
  branch: "main",
  enabled: true,
  setupPhase,
})

describe("Linear legacy sync after the move to Workspace sources (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("linear_legacy")
    repositoryId = `repo_legacy_${seed.suffix}`
    gitUrl = `https://github.com/example/context-${seed.suffix}.git`
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: `example/context-${seed.suffix}`,
        gitUrl,
      }),
    )
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${seed.orgId}`,
    )
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(repositories).where(eq(repositories.id, repositoryId)),
    )
    await seed.cleanup()
    const { closeOpenWorkflowClient } = await import(
      "../../openworkflow/client.js"
    )
    await closeOpenWorkflowClient()
  })

  it("is retired only when an ok source writes into the old sync repository", async () => {
    const connectionId = await seed.addConnection(
      "linear",
      legacyConfig("live"),
    )
    const source = (status: "ok" | "invalid") => ({
      sourceKey: "issues",
      provider: "linear" as const,
      connectionId,
      scope: { teams: ["ENG"] },
      status,
      statusDetail: null,
    })
    const other = await seed.addWorkspace("other")
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: other,
      revision: "a".repeat(40),
      rows: [source("ok")],
    })
    const retired = () =>
      linearLegacySyncRetired({
        orgId: seed.orgId,
        connectionId,
        syncRepositoryGitUrl: gitUrl,
      })
    expect(await retired()).toBe(false)

    const same = await seed.addWorkspace(
      "context",
      gitUrl.replace(/\.git$/, ""),
    )
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: same,
      revision: "b".repeat(40),
      rows: [source("invalid")],
    })
    expect(await retired()).toBe(false)
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: same,
      revision: "c".repeat(40),
      rows: [source("ok")],
    })
    expect(await retired()).toBe(true)
  })

  it("turns off the migrated legacy binding, so a merge of an old config PR starts no legacy sync", async () => {
    // Loaded after DATABASE_URL is checked: the OpenWorkflow client connects on import.
    const { enqueueConnectorContentSync } = await import(
      "../../openworkflow/enqueue-connector-content-sync.js"
    )
    const merge = (connectionId: string) =>
      enqueueConnectorContentSync({
        orgId: seed.orgId,
        connectionId,
        provider: "linear",
        repositoryId,
        branch: "main",
        configKey: `merge-${connectionId}`,
      })
    const kept = await seed.addConnection(
      "linear",
      legacyConfig("awaiting_merge"),
    )
    expect(await merge(kept)).toBe(true)

    const moved = await seed.addConnection(
      "linear",
      legacyConfig("awaiting_merge"),
    )
    await linearSourceMigrationHook.disableLegacy?.({
      orgId: seed.orgId,
      connectionId: moved,
    })
    expect(
      await getLinearBindingWithRepoByConnectionId(seed.orgId, moved),
    ).toMatchObject({
      enabled: false,
      repositoryId,
    })
    expect(await merge(moved)).toBe(false)
    const runs = await getSystemDb().execute(
      sql`select 1 from openworkflow.workflow_runs where workflow_name = 'linear-sync-content' and input->>'connectionId' = ${moved}`,
    )
    expect(runs.rows).toEqual([])
  })
})
