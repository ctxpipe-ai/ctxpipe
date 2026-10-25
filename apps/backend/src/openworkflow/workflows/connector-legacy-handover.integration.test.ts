import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { repositories } from "../../db/schema/repositories.js"
import type { SourceProvider } from "../../domain/workspace-sources/sources-file.js"
import {
  encodeLinearTokensForDb,
  encodeSlackBotTokenForDb,
} from "../../lib/connection-config.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { confluenceSyncContent } from "./confluence-sync-content.js"
import { confluenceSyncSpace } from "./confluence-sync-space.js"
import { linearSyncContent } from "./linear-sync-content.js"
import { linearSyncEntity } from "./linear-sync-entity.js"
import { slackMentionAgent } from "./slack-mention-agent.js"

/**
 * After the migration, a Workspace source owns the old sync repository. The
 * legacy Linear, Slack and Confluence syncs must then stop before they read
 * the repository or the provider: msw rejects each request to GitHub or to
 * the provider, except the Slack status replies of the mention agent.
 */
const slackCalls: string[] = []
const server = setupServer(
  http.post("https://slack.com/api/:method", ({ params }) => {
    const method = String(params.method)
    slackCalls.push(method)
    if (method === "chat.postMessage" || method === "chat.update")
      return HttpResponse.json({ ok: true, ts: "1790000700.000100" })
    return HttpResponse.json({ ok: false, error: "unexpected_call" })
  }),
)

describe("legacy connector workflows after the handover (Postgres)", () => {
  let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
  let backend: BackendPostgres
  let runner: OpenWorkflow
  let worker: ReturnType<OpenWorkflow["newWorker"]>

  /** An old sync repository that a Workspace with an `ok` source now owns. */
  const handedOverRepository = async (
    name: string,
    provider: SourceProvider,
    connection: (repositoryId: string) => Promise<string>,
    scope: Record<string, unknown>,
  ) => {
    const repositoryId = `repo_${name}_${seed.suffix}`
    const gitUrl = `https://github.com/acme/${name}-${seed.suffix}.git`
    const github = await seed.addConnection("github", {})
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: `acme/${name}`,
        gitUrl,
        githubConnectionId: github,
      }),
    )
    const id = await connection(repositoryId)
    const bind = async () => {
      await replaceWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId: await seed.addWorkspace(
          name,
          gitUrl.replace(/\.git$/, ""),
        ),
        revision: "a".repeat(40),
        rows: [
          {
            sourceKey: name,
            provider,
            connectionId: id,
            scope,
            status: "ok",
            statusDetail: null,
          },
        ],
      })
    }
    return { repositoryId, connectionId: id, bind }
  }

  const linearConnection = async (name: string, setupPhase: string) => {
    const env = parseEnv(process.env)
    const repo = await handedOverRepository(
      name,
      "linear",
      (repositoryId) =>
        seed.addConnection("linear", {
          ...encodeLinearTokensForDb(
            { accessToken: "lin_fixture", refreshToken: null },
            env,
          ),
          accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
          workspaceId: "lin_ws_fixture",
          status: "installed",
          repositoryId,
          branch: "main",
          enabled: true,
          setupPhase,
        }),
      { teams: ["ENG"] },
    )
    await repo.bind()
    return repo.connectionId
  }

  const confluenceConnection = async (name: string, setupPhase: string) => {
    const repo = await handedOverRepository(
      name,
      "confluence",
      () =>
        seed.addConnection("forge", {
          status: "installed",
          cloudId: "cloud_fixture",
          appSystemToken: "forge_fixture",
          atlassianApiBaseUrl: "https://api.atlassian.com",
        }),
      { spaces: [{ key: "ENG", pages: "all" }] },
    )
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(confluenceSyncTargets).values({
        id: `cst_${name}_${seed.suffix}`,
        orgId: seed.orgId,
        connectionId: repo.connectionId,
        repositoryId: repo.repositoryId,
        branch: "main",
        setupPhase,
      }),
    )
    await repo.bind()
    return repo.connectionId
  }

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("legacy_handover")
    backend = await BackendPostgres.connect(process.env.DATABASE_URL ?? "", {
      runMigrations: false,
      // Content activation reads its own run in this namespace.
      namespaceId: openWorkflowNamespaceId(),
    })
    runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(linearSyncEntity.spec, linearSyncEntity.fn)
    runner.implementWorkflow(linearSyncContent.spec, linearSyncContent.fn)
    runner.implementWorkflow(confluenceSyncSpace.spec, confluenceSyncSpace.fn)
    runner.implementWorkflow(
      confluenceSyncContent.spec,
      confluenceSyncContent.fn,
    )
    runner.implementWorkflow(slackMentionAgent.spec, slackMentionAgent.fn)
    worker = runner.newWorker({ concurrency: 1 })
    await worker.start()
  })

  afterAll(async () => {
    await worker?.stop()
    await backend?.stop()
    server.close()
    await seed?.cleanup()
  })

  it("stops the Linear issue sync of a live binding", async () => {
    const connectionId = await linearConnection("lin-live", "live")
    const handle = await runner.runWorkflow(linearSyncEntity.spec, {
      orgId: seed.orgId,
      connectionId,
      entityType: "issue",
      externalId: "issue_1",
      action: "upsert",
    })
    expect(await handle.result({ timeoutMs: 20_000 })).toEqual({
      written: 0,
      deleted: 0,
      failures: [],
    })
  }, 30_000)

  it("stops the Linear initial content sync", async () => {
    const connectionId = await linearConnection("lin-initial", "initial_sync")
    const handle = await runner.runWorkflow(linearSyncContent.spec, {
      orgId: seed.orgId,
      connectionId,
    })
    expect(await handle.result({ timeoutMs: 20_000 })).toMatchObject({
      status: "superseded",
      written: 0,
    })
  }, 30_000)

  it("stops the Confluence space sync", async () => {
    const connectionId = await confluenceConnection("conf-space", "live")
    const handle = await runner.runWorkflow(confluenceSyncSpace.spec, {
      orgId: seed.orgId,
      connectionId,
      spaceKey: "ENG",
    })
    expect(await handle.result({ timeoutMs: 20_000 })).toMatchObject({
      status: "superseded",
      pagesProcessed: 0,
    })
  }, 30_000)

  it("stops the Confluence initial content sync", async () => {
    const connectionId = await confluenceConnection("conf-content", "live")
    const handle = await runner.runWorkflow(confluenceSyncContent.spec, {
      orgId: seed.orgId,
      connectionId,
      orgSlug: seed.orgId,
    })
    expect(await handle.result({ timeoutMs: 20_000 })).toMatchObject({
      status: "superseded",
      written: 0,
    })
  }, 30_000)

  it("does not capture a Slack thread into the old repository", async () => {
    const env = parseEnv(process.env)
    const repo = await handedOverRepository(
      "slack-capture",
      "slack",
      (repositoryId) =>
        seed.addConnection("slack", {
          botTokenEnc: encodeSlackBotTokenForDb("xoxb-test", env),
          teamId: `T0${seed.suffix}`.slice(0, 20),
          teamName: "Example",
          botUserId: "U0BOT0001",
          status: "installed",
          repositoryId,
          branch: "main",
          enabled: true,
        }),
      // The source does not hold the channel of the mention.
      { channels: ["C0OTHER01"] },
    )
    await repo.bind()
    slackCalls.length = 0
    const handle = await runner.runWorkflow(slackMentionAgent.spec, {
      orgId: seed.orgId,
      connectionId: repo.connectionId,
      channelId: "C0ENG0001",
      threadTs: "1790000000.000100",
    })
    expect(await handle.result({ timeoutMs: 20_000 })).toEqual({
      kind: "failed",
      errorCode: "no_source",
    })
    // Only the status replies; the thread is not read for the old capture.
    expect(slackCalls.every((method) => method.startsWith("chat."))).toBe(true)
  }, 30_000)
})
