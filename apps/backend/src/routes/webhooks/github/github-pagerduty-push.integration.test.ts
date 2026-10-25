import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { useMswServer } from "../../../../test/msw.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../../db/client.js"
import { organizations } from "../../../db/schema/auth.js"
import {
  CONNECTION_TYPE_PAGERDUTY,
  connectionDirectory,
  connections,
} from "../../../db/schema/connections.js"
import { repositories } from "../../../db/schema/repositories.js"
import { workspaces } from "../../../db/schema/workspaces.js"
import { generateObjectId } from "../../../lib/id.js"
import { upsertConnectionDirectory } from "../../../models/connection-directory.js"
import { getPagerdutyBindingByConnectionId } from "../../../models/pagerduty-connector.js"
import { closeOpenWorkflowClient } from "../../../openworkflow/client.js"
import { renderPagerdutyConfigYaml } from "../../../services/pagerduty/config-yaml.js"
import {
  type GithubTokenLog,
  githubTokenHandlers,
  insertGithubConnection,
  stubGithubApp,
} from "../../../test/ingest-github.js"
import { maybeActivatePagerdutySyncOnConfigPush } from "./github-pagerduty-push.js"

/*
 * The Workspace root folder (CTX-709) at the PagerDuty config push webhook:
 * the installation, repository, Workspace, and binding come from Postgres,
 * and msw stands in for GitHub. The org has a Workspace on example-org/mono
 * with the root folder docs/ctx.
 */

const orgId = generateObjectId("org")
const githubConnectionId = generateObjectId("con")
const pagerdutyConnectionId = generateObjectId("con")
const repositoryId = generateObjectId("repo")
const installationId = 777_002
const repositoryName = "example-org/mono"
const repo = `https://api.github.com/repos/${repositoryName}`
const ROOT = "docs/ctx"

const server = useMswServer()

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  stubGithubApp()
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Root folder PagerDuty push proof",
    createdAt: new Date(),
  })
  await insertGithubConnection({
    orgId,
    id: githubConnectionId,
    installationId,
    accountSlug: "example-org",
  })
  await withOrgDbContext(orgId, async (db) => {
    const [github] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, githubConnectionId))
    if (github) await upsertConnectionDirectory(github)
    await db.insert(repositories).values({
      id: repositoryId,
      orgId,
      name: repositoryName,
      gitUrl: `https://github.com/${repositoryName}.git`,
      githubConnectionId,
    })
    await db.insert(workspaces).values({
      id: generateObjectId("ws"),
      orgId,
      slug: `mono-${orgId}`,
      displayName: "Mono",
      workspaceRepositoryUrl: `https://github.com/${repositoryName}`,
      rootPath: ROOT,
      githubConnectionId,
      writeStatus: "writable",
    })
    await db.insert(connections).values({
      id: pagerdutyConnectionId,
      orgId,
      type: CONNECTION_TYPE_PAGERDUTY,
      config: {
        accountId: "PDACCT",
        accountName: "Example PD",
        accountSubdomain: "example",
        region: "us",
        ownerUserId: "user_pd_root",
        status: "installed",
        setupPhase: "awaiting_merge",
        enabled: true,
        repositoryId,
        branch: "main",
      },
    })
  })
})

afterAll(async () => {
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where input->>'orgId' = ${orgId}`,
  )
  await getSystemDb()
    .delete(connectionDirectory)
    .where(eq(connectionDirectory.orgId, orgId))
  await withOrgDbContext(orgId, async (db) => {
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    await db.delete(connections).where(eq(connections.orgId, orgId))
    await db.delete(repositories).where(eq(repositories.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeOpenWorkflowClient()
  await closeDb()
})

it("activates the PagerDuty sync only for the config file below the root folder", async () => {
  const log: GithubTokenLog = { minted: [], revoked: [] }
  const reads: string[] = []
  const config = renderPagerdutyConfigYaml({
    accountId: "PDACCT",
    accountName: "Example PD",
    accountSubdomain: "example",
    region: "us",
    services: [],
  })
  server.use(
    ...githubTokenHandlers(log, () => "fixture-only-read-token"),
    http.get(`${repo}/contents/*`, ({ request }) => {
      const path = decodeURIComponent(
        new URL(request.url).pathname.slice(
          `/repos/${repositoryName}/contents/`.length,
        ),
      )
      reads.push(path)
      if (path !== `${ROOT}/pagerduty/config.yaml`)
        return HttpResponse.json({ message: "Not Found" }, { status: 404 })
      return HttpResponse.json({
        type: "file",
        encoding: "base64",
        size: config.length,
        content: Buffer.from(config).toString("base64"),
      })
    }),
  )
  const push = {
    installationId,
    githubConnectionId,
    repoFullName: repositoryName,
    ref: "refs/heads/main",
    log: { error: vi.fn() },
  }
  const phase = async () =>
    (await getPagerdutyBindingByConnectionId(orgId, pagerdutyConnectionId))
      ?.setupPhase

  // The same file path at the repository root is outside the root folder.
  await maybeActivatePagerdutySyncOnConfigPush({
    ...push,
    commits: [{ modified: ["pagerduty/config.yaml"] }],
  })
  expect(reads).toEqual([])
  expect(await phase()).toBe("awaiting_merge")

  await maybeActivatePagerdutySyncOnConfigPush({
    ...push,
    commits: [{ modified: [`${ROOT}/pagerduty/config.yaml`] }],
  })
  expect(reads).toEqual([`${ROOT}/pagerduty/config.yaml`])
  expect(push.log.error).not.toHaveBeenCalled()
  expect(await phase()).toBe("initial_sync")
  const runs = await getSystemDb().execute<{
    workflowName: string
    connectionId: string
  }>(
    sql`select workflow_name as "workflowName", input->>'connectionId' as "connectionId" from openworkflow.workflow_runs where input->>'orgId' = ${orgId}`,
  )
  expect(runs.rows).toEqual([
    {
      workflowName: "pagerduty-sync-content",
      connectionId: pagerdutyConnectionId,
    },
  ])
})
