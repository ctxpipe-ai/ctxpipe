import { generateKeyPairSync } from "node:crypto"

import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { describeWithDatabase } from "../../../test/db.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  connectionDirectory,
  connections,
} from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { sweepRepositoryDisk } from "../../domain/codesearchCheckoutGc.js"
import { generateObjectId } from "../../lib/id.js"
import {
  invalidateGithubAppCacheForConnection,
  upsertInstallation,
} from "../../models/github-installation.js"
import { processGithubWebhookPayload } from "../../routes/webhooks/github/github.js"
import { GIT_REMOTE_ACCESS_MESSAGES } from "../../services/git/clone-tree.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { repositoryIndex } from "./repository-index.js"

const SHA = "c0ffee0000000000000000000000000000000001"
const CODESEARCH = "http://codesearch.lost-access.test"

describeWithDatabase("repository-index after a lost GitHub access", () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const orgId = generateObjectId("org")
  const repositoryId = generateObjectId("repo")
  const namespace = `index_lost_access_${suffix}`
  // Unique for each run: the webhook finds connections by this id.
  const installationId = 900_000_000 + Math.floor(Math.random() * 99_999_999)
  const repoName = `lost-access-${suffix}`
  const fullName = `fixture/${repoName}`
  // What GitHub answers for an installation token of the repository.
  let github: "refused" | "unavailable" | "granted" = "refused"
  let connectionId = ""
  const server = setupServer(
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      () =>
        github === "refused"
          ? HttpResponse.json(
              {
                message:
                  "There is at least one repository that does not exist or is not accessible to the parent installation.",
              },
              { status: 422 },
            )
          : github === "unavailable"
            ? HttpResponse.json({ message: "Server Error" }, { status: 502 })
            : HttpResponse.json(
                {
                  token: "fixture-only-read-token",
                  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                  permissions: { contents: "read", metadata: "read" },
                },
                { status: 201 },
              ),
    ),
    // Codesearch lost the published checkout of the repository.
    http.post(`${CODESEARCH}/:repositoryId/checkouts/sweep`, () =>
      HttpResponse.json({
        deletedEntries: 0,
        deletedBytes: 0,
        publishedMissing: true,
      }),
    ),
    http.post(
      `${CODESEARCH}/:repositoryId/index/clone-checkout`,
      async ({ request }) => {
        const body = (await request.json()) as { targetHash: string }
        return HttpResponse.json({
          ok: true,
          targetHash: body.targetHash,
          ingestMode: "full",
          changedPaths: [],
          deletedPaths: [],
          renames: [],
        })
      },
    ),
    http.post(`${CODESEARCH}/:repositoryId/index/zoekt`, () =>
      HttpResponse.json({ ok: true }),
    ),
    http.post(`${CODESEARCH}/:repositoryId/index/detect-languages`, () =>
      HttpResponse.json({
        ok: true,
        detectedLanguages: [],
        languagesToIndex: [],
      }),
    ),
    http.post(`${CODESEARCH}/:repositoryId/index/merge-scip`, () =>
      HttpResponse.json({ ok: true, shardCount: 0 }),
    ),
  )
  let backend: BackendPostgres | undefined
  let worker: ReturnType<OpenWorkflow["newWorker"]> | undefined
  let runner: OpenWorkflow | undefined

  const repositoryState = async () => {
    const [row] = await withOrgDbContext(orgId, (db) =>
      db
        .select({
          indexReady: repositories.indexReady,
          indexingStatus: repositories.indexingStatus,
          indexingError: repositories.indexingError,
          lastIngestedHash: repositories.lastIngestedHash,
        })
        .from(repositories)
        .where(eq(repositories.id, repositoryId)),
    )
    return row
  }
  const rebuild = () => {
    if (!runner) throw new Error("OpenWorkflow runner missing")
    return runner.runWorkflow(repositoryIndex.spec, {
      orgId,
      repositoryId,
      targetHash: SHA,
      ingestionV2: true,
      rebuild: true,
    })
  }
  const queuedRebuilds = async () => {
    const { rows } = await getSystemDb().execute<{ input: unknown }>(
      sql`select input from openworkflow.workflow_runs
        where namespace_id = ${openWorkflowNamespaceId()}
          and workflow_name = 'repository-index'
          and input->>'repositoryId' = ${repositoryId}`,
    )
    return rows.map((row) => row.input)
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new Error("DATABASE_URL is unset")
    vi.stubEnv("AUTH_SECRET", "ci-auth-secret-must-be-at-least-32-chars")
    vi.stubEnv("CODESEARCH_URL", CODESEARCH)
    vi.stubEnv("GITHUB_APP_ID", "12345")
    vi.stubEnv(
      "GITHUB_PRIVATE_KEY",
      generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
    )
    server.listen({ onUnhandledRequest: "error" })
    initDb(databaseUrl)
    await getSystemDb()
      .insert(organizations)
      .values({
        id: orgId,
        name: "Lost GitHub access",
        slug: `lost-access-${suffix}`,
        createdAt: new Date(),
      })
    const connection = await upsertInstallation(
      orgId,
      installationId,
      parseEnv(process.env),
    )
    connectionId = connection.id
    await withOrgDbContext(orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId,
        name: repoName,
        gitUrl: `https://github.com/${fullName}.git`,
        githubConnectionId: connectionId,
        indexReady: true,
        indexingStatus: "ready",
        lastIngestedHash: SHA,
      }),
    )
    backend = await BackendPostgres.connect(databaseUrl, {
      runMigrations: false,
      namespaceId: namespace,
    })
    runner = new OpenWorkflow({ backend })
    runner.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
    worker = runner.newWorker({ concurrency: 1 })
    await worker.start()
  })

  afterAll(async () => {
    await worker?.stop()
    await backend?.stop()
    server.close()
    vi.unstubAllEnvs()
    if (!process.env.DATABASE_URL) return
    await getSystemDb().execute(
      sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace} or input->>'orgId' = ${orgId}`,
    )
    await withOrgDbContext(orgId, async (db) => {
      await db.delete(repositories).where(eq(repositories.orgId, orgId))
      await db.delete(connections).where(eq(connections.orgId, orgId))
    })
    await getSystemDb()
      .delete(connectionDirectory)
      .where(eq(connectionDirectory.orgId, orgId))
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    invalidateGithubAppCacheForConnection(connectionId)
    await closeDb()
  })

  it(
    "stops the hourly rebuild after GitHub refuses the repository, and indexes it again when the installation gets it back",
    { timeout: 60_000 },
    async () => {
      // Codesearch lost the published checkout: the sweep rebuilds it.
      expect(
        (await sweepRepositoryDisk(orgId, repositoryId, [])).rebuild,
      ).toEqual({ orgId, repositoryId, sha: SHA })

      // A transient GitHub failure fails the run, and the sweep tries again.
      github = "unavailable"
      await expect(
        (await rebuild()).result({ timeoutMs: 15_000 }),
      ).rejects.toThrow()
      expect(await repositoryState()).toMatchObject({
        indexingStatus: "ready",
        indexingError: null,
      })
      expect(
        (await sweepRepositoryDisk(orgId, repositoryId, [])).rebuild,
      ).toEqual({ orgId, repositoryId, sha: SHA })

      // The installation lost the repository: GitHub answers 422.
      github = "refused"
      await expect(
        (await rebuild()).result({ timeoutMs: 15_000 }),
      ).rejects.toThrow(GIT_REMOTE_ACCESS_MESSAGES.denied)
      // The UI shows the fix. The published revision stays readable.
      expect(await repositoryState()).toEqual({
        indexReady: true,
        indexingStatus: "failed",
        indexingError: GIT_REMOTE_ACCESS_MESSAGES.denied,
        lastIngestedHash: SHA,
      })
      // The sweep does not queue the run again.
      expect(
        (await sweepRepositoryDisk(orgId, repositoryId, [])).rebuild,
      ).toBeUndefined()

      // The installation gets another repository: nothing to index.
      const ctx = {
        env: parseEnv(process.env),
        log: { error: (error: Error) => expect(error).toBeUndefined() },
      } as unknown as Parameters<typeof processGithubWebhookPayload>[2]
      const added = (name: string, deliveryId: string) =>
        processGithubWebhookPayload(
          "installation_repositories",
          {
            action: "added",
            installation: { id: installationId },
            repositories_added: [{ full_name: name }],
          },
          ctx,
          { deliveryId },
        )
      await added("fixture/another-repository", `other_${suffix}`)
      expect(await queuedRebuilds()).toEqual([])

      // The installation gets the repository back: one rebuild, also when
      // GitHub delivers the event again.
      github = "granted"
      await added(fullName, `back_${suffix}`)
      await added(fullName, `back_${suffix}`)
      const queued = await queuedRebuilds()
      expect(queued).toEqual([
        {
          orgId,
          repositoryId,
          targetHash: SHA,
          ingestionV2: true,
          rebuild: true,
        },
      ])
      await expect(
        (await rebuild()).result({ timeoutMs: 15_000 }),
      ).resolves.toMatchObject({ targetHash: SHA, searchIndexOk: true })
      expect(await repositoryState()).toEqual({
        indexReady: true,
        indexingStatus: "ready",
        indexingError: null,
        lastIngestedHash: SHA,
      })
    },
  )
})
