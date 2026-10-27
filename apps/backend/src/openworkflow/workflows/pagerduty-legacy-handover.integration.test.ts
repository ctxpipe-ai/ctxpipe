import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { pagerdutySyncContent } from "./pagerduty-sync-content.js"
import { pagerdutySyncEntity } from "./pagerduty-sync-entity.js"

/**
 * After the migration, a Workspace source owns the old sync repository. The
 * legacy PagerDuty workflows must then stop before they read PagerDuty or
 * GitHub: msw rejects each outbound request.
 */
const server = setupServer()

describe("PagerDuty legacy workflows after the handover (Postgres)", () => {
  let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
  let backend: BackendPostgres
  let runner: OpenWorkflow
  let worker: ReturnType<OpenWorkflow["newWorker"]>
  const connectionFor = async (setupPhase: string) => {
    const env = parseEnv(process.env)
    const repositoryId = `repo_pd_${setupPhase}_${seed.suffix}`
    const gitUrl = `https://github.com/acme/pd-${setupPhase}-${seed.suffix}.git`
    const github = await seed.addConnection("github", {})
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: `acme/pd-${setupPhase}`,
        gitUrl,
        githubConnectionId: github,
      }),
    )
    const connectionId = await seed.addConnection("pagerduty", {
      accessTokenEnc: encryptConnectionSecret("fixture-token", env),
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      accountId: "PACCT01",
      accountName: "Acme Test",
      accountSubdomain: "acme-test",
      region: "us",
      ownerUserId: "user_fixture",
      status: "installed",
      repositoryId,
      branch: "main",
      enabled: true,
      setupPhase,
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: await seed.addWorkspace(
        `pd-handover-${setupPhase.replaceAll("_", "-")}`,
        gitUrl.replace(/\.git$/, ""),
      ),
      revision: "a".repeat(40),
      rows: [
        {
          sourceKey: "on-call",
          provider: "pagerduty",
          connectionId,
          scope: { services: ["PSVC001"] },
          status: "ok",
          statusDetail: null,
        },
      ],
    })
    return connectionId
  }

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("pd_legacy_handover")
    backend = await BackendPostgres.connect(process.env.DATABASE_URL ?? "", {
      runMigrations: false,
      namespaceId: `pd_legacy_handover_${seed.suffix}`,
    })
    runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(pagerdutySyncEntity.spec, pagerdutySyncEntity.fn)
    runner.implementWorkflow(pagerdutySyncContent.spec, pagerdutySyncContent.fn)
    worker = runner.newWorker({ concurrency: 1 })
    await worker.start()
  })

  afterAll(async () => {
    await worker?.stop()
    await backend?.stop()
    server.close()
    await seed.cleanup()
  })

  it("stops the incident sync of a live binding", async () => {
    const connectionId = await connectionFor("live")
    const handle = await runner.runWorkflow(pagerdutySyncEntity.spec, {
      orgId: seed.orgId,
      connectionId,
      incidentId: "PINC001",
    })
    expect(await handle.result({ timeoutMs: 20_000 })).toEqual({
      written: 0,
      deleted: 0,
      errors: [],
    })
  }, 30_000)

  it("stops the initial content sync", async () => {
    const connectionId = await connectionFor("initial_sync")
    const handle = await runner.runWorkflow(pagerdutySyncContent.spec, {
      orgId: seed.orgId,
      connectionId,
    })
    expect(await handle.result({ timeoutMs: 20_000 })).toMatchObject({
      status: "superseded",
      written: 0,
    })
  }, 30_000)
})
