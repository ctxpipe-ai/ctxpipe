import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { isLegacyBindingHandedOver } from "../../domain/workspace-sources/legacy-handover.js"
import { planSourceMigration } from "../../domain/workspace-sources/migration-plan.js"
import {
  parseSourceEntry,
  sourcesFileSchema,
} from "../../domain/workspace-sources/sources-file.js"
import { applySourcesYamlChange } from "../../domain/workspace-sources/sources-yaml-edit.js"
import { parseSourcesYaml } from "../../domain/workspace-sources/sources-yaml.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { parseNotionConfigYamlContent } from "./config-yaml.js"
import { loadNotionStoredConfig } from "./connection-load.js"
import { createNotionSourceMigrationHook } from "./workspace-source-migration.js"

/** A `notion/config.yaml` as the old Notion settings wrote it. */
const LEGACY_CONFIG = `version: 1
source: notion
resources:
  - id: 1a2b3c4d-0000-4000-8000-000000000002
    type: database
    title: Tasks
  - id: 1A2B3C4D000040008000000000000001
    type: page
    title: Handbook
`

const HANDBOOK = "1a2b3c4d-0000-4000-8000-000000000001"
const TASKS = "1a2b3c4d-0000-4000-8000-000000000002"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

/** Notion now calls the Handbook root "Company handbook". */
const server = setupServer(
  http.get("https://api.notion.com/v1/pages/:pageId", ({ params }) =>
    params.pageId === HANDBOOK
      ? HttpResponse.json({
          object: "page",
          id: HANDBOOK,
          parent: { type: "workspace", workspace: true },
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Company handbook" }],
            },
          },
        })
      : HttpResponse.json({ message: "Not found" }, { status: 404 }),
  ),
)

describe("Notion source migration hook (Postgres)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("wsrc_notion_migrate")
  })
  afterAll(async () => {
    server.close()
    await seed.cleanup()
  })

  async function addRepository(name: string) {
    const github = await seed.addConnection("github", {})
    const repositoryId = `repo_${name}_${seed.suffix}`
    const gitUrl = `https://github.com/acme/${name}-${seed.suffix}.git`
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: `acme/${name}`,
        gitUrl,
        githubConnectionId: github,
      }),
    )
    return { repositoryId, gitUrl }
  }

  it("turns the old notion/config.yaml into a source entry", async () => {
    const { repositoryId, gitUrl } = await addRepository("notion-context")
    const binding = { repositoryId, branch: "main", enabled: true }
    const live = await seed.addConnection("notion", {
      ...binding,
      setupPhase: "live",
    })
    const pending = await seed.addConnection("notion", {
      ...binding,
      setupPhase: "awaiting_merge",
    })
    const off = await seed.addConnection("notion", {
      ...binding,
      enabled: false,
      setupPhase: "live",
    })
    const unbound = await seed.addConnection("notion", {})
    const reads: string[] = []
    const hook = createNotionSourceMigrationHook(async (input) => {
      reads.push(`${input.repositoryName}@${input.branch}`)
      return parseNotionConfigYamlContent(LEGACY_CONFIG)
    })

    const bindings = await hook.listLegacyBindings({
      orgId: seed.orgId,
      env: parseEnv(process.env),
    })

    const scope = {
      pages: [{ id: HANDBOOK, title: "Handbook" }],
      databases: [{ id: TASKS, title: "Tasks" }],
    }
    const byConnection = new Map(
      bindings.map((item) => [item.connectionId, item]),
    )
    expect(byConnection.get(live)).toEqual({
      provider: "notion",
      connectionId: live,
      syncRepositoryUrl: gitUrl,
      scope,
    })
    expect(byConnection.get(pending)).toMatchObject({
      unmapped: expect.stringMatching(/not merged/),
    })
    expect(byConnection.get(off)).toMatchObject({
      unmapped: expect.stringMatching(/turned off/),
    })
    expect(byConnection.get(unbound)).toMatchObject({
      unmapped: expect.stringMatching(/no sync repository/),
    })
    expect(reads).toEqual(["acme/notion-context@main"])

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
      bindings: [...byConnection.values()],
    })
    let text: string | null = null
    for (const change of changes.get("ws_context") ?? [])
      text = applySourcesYamlChange(text, change).text
    const file = sourcesFileSchema.parse(parseSourcesYaml(text ?? ""))
    expect(file.sources.map(parseSourceEntry)).toEqual([
      {
        ok: true,
        entry: expect.objectContaining({
          provider: "notion",
          connectionId: live,
          scope,
        }),
      },
    ])
  })

  it("reports an old config that does not map", async () => {
    const { repositoryId } = await addRepository("notion-empty")
    const connection = await seed.addConnection("notion", {
      repositoryId,
      branch: "main",
      setupPhase: "live",
    })
    const hook = createNotionSourceMigrationHook(async () =>
      parseNotionConfigYamlContent(
        "version: 1\nsource: notion\nresources: []\n",
      ),
    )
    const bindings = await hook.listLegacyBindings({
      orgId: seed.orgId,
      env: parseEnv(process.env),
    })
    expect(bindings.find((item) => item.connectionId === connection)).toEqual({
      provider: "notion",
      connectionId: connection,
      unmapped: expect.stringMatching(/at least one Notion page or database/),
    })
  })

  it("hands a legacy binding over to Workspace sources", async () => {
    const { repositoryId, gitUrl } = await addRepository("notion-handover")
    const connection = await seed.addConnection("notion", {
      repositoryId,
      branch: "main",
      setupPhase: "live",
      accessToken: "fixture-token",
    })
    const handedOver = () =>
      isLegacyBindingHandedOver("notion", {
        orgId: seed.orgId,
        connectionId: connection,
        repositoryGitUrl: gitUrl,
      })
    expect(await handedOver()).toBe(false)

    const workspaceId = await seed.addWorkspace(
      `notion-handover-${seed.suffix}`.slice(0, 40),
      gitUrl.replace(/\.git$/, ""),
    )
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [
        {
          sourceKey: "notes",
          provider: "notion",
          connectionId: connection,
          scope: { pages: [{ id: HANDBOOK, title: "Handbook" }] },
          status: "ok",
          statusDetail: null,
        },
      ],
    })
    expect(await handedOver()).toBe(true)

    // --apply turns the legacy binding off and keeps the tokens.
    await createNotionSourceMigrationHook().disableLegacy?.({
      orgId: seed.orgId,
      connectionId: connection,
    })
    const stored = await loadNotionStoredConfig(seed.orgId, connection)
    expect(stored?.enabled).toBe(false)
    expect(stored?.accessToken).toBe("fixture-token")
  })

  it("does not hand over for a source of another Notion connection", async () => {
    const { repositoryId, gitUrl } = await addRepository("notion-other")
    const legacy = await seed.addConnection("notion", {
      repositoryId,
      branch: "main",
      setupPhase: "live",
    })
    const other = await seed.addConnection("notion", { status: "installed" })
    const workspaceId = await seed.addWorkspace(
      `notion-other-${seed.suffix}`.slice(0, 40),
      gitUrl.replace(/\.git$/, ""),
    )
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "b".repeat(40),
      rows: [
        {
          sourceKey: "other-notes",
          provider: "notion",
          connectionId: other,
          scope: { pages: [{ id: HANDBOOK, title: "Handbook" }] },
          status: "ok",
          statusDetail: null,
        },
      ],
    })
    expect(
      await isLegacyBindingHandedOver("notion", {
        orgId: seed.orgId,
        connectionId: legacy,
        repositoryGitUrl: gitUrl,
      }),
    ).toBe(false)
  })

  it("names a page root with its live Notion title, as the old mirror did", async () => {
    const { repositoryId } = await addRepository("notion-live-title")
    const connection = await seed.addConnection("notion", {
      repositoryId,
      branch: "main",
      setupPhase: "live",
      accessToken: "fixture-token",
    })
    const hook = createNotionSourceMigrationHook(async () =>
      parseNotionConfigYamlContent(LEGACY_CONFIG),
    )
    const bindings = await hook.listLegacyBindings({
      orgId: seed.orgId,
      env: parseEnv(process.env),
    })
    expect(
      bindings.find((item) => item.connectionId === connection),
    ).toMatchObject({
      scope: {
        // The old mirror named the page folder with the live title, so the
        // source keeps that folder. Databases used the config title.
        pages: [{ id: HANDBOOK, title: "Company handbook" }],
        databases: [{ id: TASKS, title: "Tasks" }],
      },
    })
  })
})
