import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { BackendPostgres } from "openworkflow/postgres"
import { beforeAll, expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../../db/schema/repositories.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { listLinkedRepositoryPins } from "../../models/workspace-source-state.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceTipCheck } from "../../openworkflow/workflows/workspace-tip-check.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

it(
  "links the repositories of a GitHub source, records the ones without access, and the tip check skips them",
  { timeout: 120_000 },
  async () => {
    // A Git remote that counts reads and refuses each of them.
    let hiddenReads = 0
    const hidden = createServer((_req, res) => {
      hiddenReads++
      res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' })
      res.end()
    })
    await new Promise<void>((resolve) => hidden.listen(0, "127.0.0.1", resolve))
    const address = hidden.address()
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address")
    try {
      await withNativeHydrationFixture(
        { github: true, githubWriteView: "writable" },
        async (f) => {
          await f.publish()
          // GitHub refuses a token for the hidden repository: the
          // installation cannot read it.
          f.server.use(
            http.post(
              "https://api.github.com/app/installations/123456789/access_tokens",
              async ({ request }) => {
                const body = await request.clone().text()
                const names = (body ? JSON.parse(body) : {}).repositories
                if (!names?.includes("hidden-service")) return undefined
                return HttpResponse.json(
                  { message: "Not accessible to the installation" },
                  { status: 422 },
                )
              },
            ),
          )
          // Both linked repositories resolve locally, never on github.com.
          const gitConfig = process.env.GIT_CONFIG_GLOBAL
          if (!gitConfig) throw new Error("Missing fixture Git config")
          appendFileSync(
            gitConfig,
            [
              `[url "${f.remote}"]`,
              "\tinsteadOf = https://github.com/fixture/visible-service",
              `[url "http://127.0.0.1:${address.port}/hidden.git"]`,
              "\tinsteadOf = https://github.com/fixture/hidden-service",
              "",
            ].join("\n"),
          )

          mkdirSync(join(f.directory, ".ctxpipe"), { recursive: true })
          writeFileSync(
            join(f.directory, ".ctxpipe/sources.yaml"),
            [
              "version: 1",
              "sources:",
              "  - id: product-repos",
              "    provider: github",
              `    connection: ${f.connectionId}`,
              "    repositories: [fixture/visible-service, fixture/hidden-service]",
              // Not a connection of this org: it links nothing.
              "  - id: elsewhere",
              "    provider: github",
              "    connection: con_elsewhere",
              "    repositories: [fixture/foreign-service]",
              "",
            ].join("\n"),
          )
          f.git("add", ".ctxpipe/sources.yaml")
          f.git(
            "-c",
            "user.name=Human",
            "-c",
            "user.email=human@example.test",
            "commit",
            "-m",
            "Add a GitHub source",
          )
          f.git("push", f.remote, "HEAD:refs/heads/main")
          const hydrate = await f.runner.runWorkflow(workspaceHydrate.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision: await f.resolveRevision(true),
          })
          expect(await hydrate.result({ timeoutMs: 60_000 })).toMatchObject({
            hydrated: true,
          })
          // GitHub has no sync adapter, so the projection queues no sync.
          const backend = await BackendPostgres.connect(f.databaseUrl, {
            namespaceId: openWorkflowNamespaceId(),
            runMigrations: false,
          })
          try {
            const syncRuns = (
              await backend.listWorkflowRuns({ limit: 1000 })
            ).data.filter(
              (run) =>
                run.workflowName === "workspace-sources-sync" &&
                JSON.stringify(run.input).includes(f.org.id),
            )
            expect(syncRuns).toEqual([])
          } finally {
            await backend.stop()
          }

          const sourceRows = await withOrgDbContext(f.org.id, (db) =>
            db
              .select()
              .from(workspaceSources)
              .where(eq(workspaceSources.workspaceId, f.workspaceId)),
          )
          const source = sourceRows.find(
            (row) => row.sourceKey === "product-repos",
          )
          expect(
            sourceRows.find((row) => row.sourceKey === "elsewhere")?.status,
          ).toBe("connection_missing")
          expect(source).toMatchObject({
            provider: "github",
            connectionId: f.connectionId,
            status: "out_of_access",
          })
          expect(source?.statusDetail).toContain("fixture/hidden-service")
          expect(source?.statusDetail).not.toContain("fixture/visible-service")

          const linked = await withOrgDbContext(f.org.id, (db) =>
            listLinkedRepositoryPins(db, { workspaceId: f.workspaceId }),
          )
          expect(linked.map((row) => row.gitUrl).sort()).toEqual([
            "https://github.com/fixture/hidden-service",
            "https://github.com/fixture/visible-service",
          ])
          const bound = await withOrgDbContext(f.org.id, (db) =>
            db
              .select({
                gitUrl: repositories.gitUrl,
                githubConnectionId: repositories.githubConnectionId,
              })
              .from(repositories)
              .where(eq(repositories.orgId, f.org.id)),
          )
          expect(bound).toEqual(
            expect.arrayContaining([
              {
                gitUrl: "https://github.com/fixture/visible-service",
                githubConnectionId: f.connectionId,
              },
              {
                gitUrl: "https://github.com/fixture/hidden-service",
                githubConnectionId: null,
              },
            ]),
          )

          // Code search reads the published org checkout, so the link
          // starts the first org ingestion of the readable repository. The
          // repository without access gets none.
          const requested = await withOrgDbContext(f.org.id, (db) =>
            db
              .select({ gitUrl: repositoryIngestionRequests.repositoryUrl })
              .from(repositoryIngestionRequests)
              .where(eq(repositoryIngestionRequests.orgId, f.org.id)),
          )
          expect(requested.map((row) => row.gitUrl)).toContain(
            "https://github.com/fixture/visible-service",
          )
          expect(requested.map((row) => row.gitUrl)).not.toContain(
            "https://github.com/fixture/hidden-service",
          )

          const tipCheck = await f.runner.runWorkflow(workspaceTipCheck.spec, {
            orgId: f.org.id,
          })
          await tipCheck.result({ timeoutMs: 30_000 })
          const tips = await withOrgDbContext(f.org.id, (db) =>
            listLinkedRepositoryPins(db, { workspaceId: f.workspaceId }),
          )
          // The visible repository reads with the source's connection.
          expect(
            tips.find((row) => row.gitUrl.endsWith("/visible-service"))
              ?.desiredSha,
          ).toMatch(/^[0-9a-f]{40}$/)
          expect(hiddenReads).toBe(0)

          // An admin adds the repository to the installation. Six hours
          // after the last check, the tip check checks again and reads it.
          f.server.resetHandlers()
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(workspaceSources)
              .set({ updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) })
              .where(eq(workspaceSources.workspaceId, f.workspaceId)),
          )
          const recheck = await f.runner.runWorkflow(workspaceTipCheck.spec, {
            orgId: f.org.id,
          })
          await recheck.result({ timeoutMs: 30_000 })
          const [rechecked] = await withOrgDbContext(f.org.id, (db) =>
            db
              .select()
              .from(workspaceSources)
              .where(eq(workspaceSources.sourceKey, "product-repos")),
          )
          expect(rechecked).toMatchObject({ status: "ok", statusDetail: null })
          expect(hiddenReads).toBeGreaterThan(0)
        },
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        hidden.close((error) => (error ? reject(error) : resolve())),
      )
    }
  },
)
