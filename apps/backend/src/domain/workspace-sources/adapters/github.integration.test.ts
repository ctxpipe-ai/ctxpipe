import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { beforeAll, expect, it } from "vitest"
import { withOrgDbContext } from "../../../db/client.js"
import { repositories } from "../../../db/schema/repositories.js"
import { workspaceSources } from "../../../db/schema/workspace_sources.js"
import { workspaceLinkedRepositories } from "../../../db/schema/workspaces.js"
import { workspaceHydrate } from "../../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceTipCheck } from "../../../openworkflow/workflows/workspace-tip-check.js"
import { withNativeHydrationFixture } from "../../../test/native-hydration-fixture.js"
import { repositoryKeyFromGitUrl } from "../../workspaces/slug.js"

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

          const [source] = await withOrgDbContext(f.org.id, (db) =>
            db
              .select()
              .from(workspaceSources)
              .where(eq(workspaceSources.workspaceId, f.workspaceId)),
          )
          expect(source).toMatchObject({
            provider: "github",
            connectionId: f.connectionId,
            status: "out_of_access",
          })
          expect(source?.statusDetail).toContain("fixture/hidden-service")
          expect(source?.statusDetail).not.toContain("fixture/visible-service")

          const linked = await withOrgDbContext(f.org.id, (db) =>
            db
              .select({ gitUrl: workspaceLinkedRepositories.gitUrl })
              .from(workspaceLinkedRepositories)
              .where(
                eq(workspaceLinkedRepositories.workspaceId, f.workspaceId),
              ),
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

          // The tip check keeps links only on the org's first connector
          // Workspace (dest-workspace-assignment), so the Workspace
          // repository needs its org repository row, as in production.
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(repositories).values({
              id: `repo_${f.id}_workspace`,
              orgId: f.org.id,
              name: "fixture/hydration-contract",
              gitUrl: f.workspaceUrl,
              repositoryKey: repositoryKeyFromGitUrl(f.workspaceUrl),
              githubConnectionId: f.connectionId,
            }),
          )
          const tipCheck = await f.runner.runWorkflow(workspaceTipCheck.spec, {
            orgId: f.org.id,
          })
          await tipCheck.result({ timeoutMs: 30_000 })
          const tips = await withOrgDbContext(f.org.id, (db) =>
            db
              .select({
                gitUrl: workspaceLinkedRepositories.gitUrl,
                desiredSha: workspaceLinkedRepositories.desiredSha,
              })
              .from(workspaceLinkedRepositories)
              .where(
                eq(workspaceLinkedRepositories.workspaceId, f.workspaceId),
              ),
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
              .where(eq(workspaceSources.workspaceId, f.workspaceId)),
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
