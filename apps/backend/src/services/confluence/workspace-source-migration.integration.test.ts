import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSpaces } from "../../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { repositories } from "../../db/schema/repositories.js"
import { isLegacyBindingHandedOver } from "../../domain/workspace-sources/legacy-handover.js"
import { planSourceMigration } from "../../domain/workspace-sources/migration-plan.js"
import {
  parseSourceEntry,
  sourcesFileSchema,
} from "../../domain/workspace-sources/sources-file.js"
import { parseSourcesYaml } from "../../domain/workspace-sources/sources-yaml.js"
import { applySourcesYamlChange } from "../../domain/workspace-sources/sources-yaml-edit.js"
import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { handleForgeConfluenceContentEvent } from "./forge-confluence-webhook.js"
import { confluenceSourceMigrationHook } from "./workspace-source-migration.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

describe("Confluence source migration hook (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_conf_migrate")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("turns a live sync target and its spaces into a source entry", async () => {
    const live = await seed.addConnection("forge", { status: "installed" })
    const pending = await seed.addConnection("forge", { status: "installed" })
    const unbound = await seed.addConnection("forge", { status: "installed" })
    const gitUrl = `https://github.com/acme/context-${seed.suffix}.git`
    const repositoryId = `repo_conf_${seed.suffix}`
    // The old config: a sync target and its confluence_spaces rows.
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: "context",
        gitUrl,
      })
      await db.insert(confluenceSyncTargets).values([
        {
          id: `cst_live_${seed.suffix}`,
          orgId: seed.orgId,
          connectionId: live,
          repositoryId,
          branch: "main",
          setupPhase: "live",
        },
        {
          id: `cst_pending_${seed.suffix}`,
          orgId: seed.orgId,
          connectionId: pending,
          repositoryId,
          branch: "main",
          setupPhase: "awaiting_merge",
        },
      ])
      await db.insert(confluenceSpaces).values([
        {
          id: `csp_eng_${seed.suffix}`,
          orgId: seed.orgId,
          connectionId: live,
          spaceKey: "ENG",
          selectedPageIds: null,
        },
        {
          id: `csp_ops_${seed.suffix}`,
          orgId: seed.orgId,
          connectionId: live,
          spaceKey: "OPS",
          selectedPageIds: ["101", "202"],
        },
      ])
    })

    const bindings = await confluenceSourceMigrationHook.listLegacyBindings({
      orgId: seed.orgId,
      env: parseEnv(process.env),
    })
    expect(
      bindings.sort((a, b) => a.connectionId.localeCompare(b.connectionId)),
    ).toEqual(
      [
        {
          provider: "confluence",
          connectionId: live,
          syncRepositoryUrl: gitUrl,
          scope: {
            spaces: [
              { key: "ENG", pages: "all" },
              { key: "OPS", pages: ["101", "202"] },
            ],
          },
        },
        {
          provider: "confluence",
          connectionId: pending,
          unmapped: expect.stringMatching(/not merged/),
        },
        {
          provider: "confluence",
          connectionId: unbound,
          unmapped: expect.stringMatching(/no sync repository/),
        },
      ].sort((a, b) => a.connectionId.localeCompare(b.connectionId)),
    )

    const { changes } = planSourceMigration({
      workspaces: [
        {
          id: "ws_context",
          workspaceRepositoryUrl: gitUrl,
          githubConnectionId: "con_gh1",
          sourcesFile: null,
        },
      ],
      linked: [],
      bindings,
    })
    let text: string | null = null
    for (const change of changes.get("ws_context") ?? [])
      text = applySourcesYamlChange(text, change).text
    const file = sourcesFileSchema.parse(parseSourcesYaml(text ?? ""))
    expect(file.sources.map(parseSourceEntry)).toEqual([
      {
        ok: true,
        entry: expect.objectContaining({
          provider: "confluence",
          connectionId: live,
          scope: {
            spaces: [
              { key: "ENG", pages: "all" },
              { key: "OPS", pages: ["101", "202"] },
            ],
          },
        }),
      },
    ])
  })

  it("hands a legacy target over to Workspace sources", async () => {
    const forge = await seed.addConnection("forge", { status: "installed" })
    const gitUrl = `https://github.com/acme/handover-${seed.suffix}.git`
    const repositoryId = `repo_handover_${seed.suffix}`
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: "handover",
        gitUrl,
      })
      await db.insert(confluenceSyncTargets).values({
        id: `cst_handover_${seed.suffix}`,
        orgId: seed.orgId,
        connectionId: forge,
        repositoryId,
        branch: "main",
        setupPhase: "live",
      })
    })
    const handedOver = () =>
      isLegacyBindingHandedOver("confluence", {
        orgId: seed.orgId,
        connectionId: forge,
        repositoryGitUrl: gitUrl,
      })
    expect(await handedOver()).toBe(false)

    // The Workspace on the same repository gets a Confluence source.
    const workspaceId = await seed.addWorkspace(
      `handover-${seed.suffix}`.slice(0, 40),
      gitUrl.replace(/\.git$/, ""),
    )
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [
        {
          sourceKey: "eng",
          provider: "confluence",
          connectionId: forge,
          scope: { spaces: [{ key: "ENG", pages: "all" }] },
          status: "ok",
          statusDetail: null,
        },
      ],
    })
    expect(await handedOver()).toBe(true)
    // A Forge event stops before it reads the repository or Confluence.
    expect(
      await handleForgeConfluenceContentEvent({
        orgId: seed.orgId,
        connectionId: forge,
        env: parseEnv(process.env),
        spaceKey: "ENG",
      }),
    ).toBe("skipped")

    // --apply turns the legacy target off.
    await confluenceSourceMigrationHook.disableLegacy?.({
      orgId: seed.orgId,
      connectionId: forge,
    })
    const target = await getConfluenceSyncTargetWithRepoByConnectionId(
      seed.orgId,
      forge,
    )
    expect(target?.enabled).toBe(false)
  })
})
