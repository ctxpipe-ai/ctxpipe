import { generateKeyPairSync } from "node:crypto"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { BackendPostgres } from "openworkflow/postgres"
import { connections } from "../../db/schema/connections.js"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { adaptTanstackHandle } from "../../domain/workspaces/job-sandbox.js"
import {
  attachWorkspaceSandbox,
  destroyWorkspaceSandbox,
} from "../../domain/workspaces/sandbox-registry.js"
import { OpenAPIHono } from "@hono/zod-openapi"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { workspaces } from "../../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../../domain/workspaces/revision.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { workspaceFilesRoutes } from "./workspace-files-routes.js"

async function withFilesWorkspace(
  run: (fixture: {
    app: OpenAPIHono<AppEnv>
    orgId: string
    workspaceId: string
    revision: WorkspaceRevision
    directory: string
  }) => Promise<void>,
) {
  const env = parseEnv(process.env)
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-files-http-"))
  const id = `files_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const org = { id: `org_${id}`, slug: id, name: "Files HTTP contract" }
  const workspaceId = `ws_${id}`
  initDb(env.DATABASE_URL)
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
    git("init", "-b", "main")
    await writeFile(join(directory, "AGENTS.md"), "# Published instructions\n")
    await writeFile(join(directory, "logo.png"), Buffer.from("png\0bytes"))
    git("add", ".")
    git(
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-m",
      "Published files",
    )
    const sha = git("rev-parse", "HEAD")
    const revision: WorkspaceRevision = {
      workspaceId,
      generation: 1,
      remote: { url: pathToFileURL(directory).href, connectionId: null },
      defaultBranch: "main",
      sha,
      access: "read",
    }
    // The remote has advanced; HTTP must still return the published commit.
    await writeFile(join(directory, "AGENTS.md"), "# Future instructions\n")
    git("add", ".")
    git(
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-m",
      "Future files",
    )
    await getSystemDb()
      .insert(organizations)
      .values({ ...org, createdAt: new Date() })
    await withOrgDbContext(org.id, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId: org.id,
        slug: "knowledge",
        displayName: org.name,
        workspaceRepositoryUrl: "file:///unavailable-replacement.git",
        desiredGeneration: 2,
        desiredSha: git("rev-parse", "HEAD"),
        desiredDefaultBranch: "main",
        activeRevision: revision,
        activeProjectionUrl: revision.remote.url,
        activeProjectionSha: sha,
        hydrateStatus: "pending",
        writeStatus: "writable",
      }),
    )
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", contextStorage(), withTestRequestLogger)
    // The seam starts after authentication; models and org/RLS contexts run for real.
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("orgId", org.id)
      c.set("orgSlug", org.slug)
      c.set("user", {
        id: `user_${id}`,
        name: "Contract",
        email: "contract@example.test",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      c.set("session", {
        id: `sess_${id}`,
        userId: `user_${id}`,
        token: id,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      await withOrgIdContext(org, next)
    })
    app.route("/workspaces", workspaceFilesRoutes)
    await run({ app, orgId: org.id, workspaceId, revision, directory })
  } finally {
    try {
      await getSystemDb().execute(
        sql`delete from openworkflow.workflow_runs where input->>'workspaceId' = ${workspaceId}`,
      )
      await withOrgDbContext(org.id, (db) =>
        db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
      )
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, org.id))
    } finally {
      await closeDb()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

it(
  "serves the published tree and bytes over HTTP while its remote advances and the Workspace relinks",
  { timeout: 30_000 },
  async () => {
    await withFilesWorkspace(async ({ app, revision }) => {
      const tree = await app.request("/workspaces/knowledge/files/tree")
      expect(tree.status).toBe(200)
      expect(await tree.json()).toEqual({
        sha: revision.sha,
        paths: ["AGENTS.md", "logo.png"],
      })
      const blob = await app.request(
        "/workspaces/knowledge/files/blob?path=AGENTS.md",
      )
      expect(blob.status).toBe(200)
      expect(await blob.json()).toEqual({
        path: "AGENTS.md",
        body: "# Published instructions\n",
        binary: false,
      })
      const binary = await app.request(
        "/workspaces/knowledge/files/blob?path=logo.png",
      )
      expect(binary.status).toBe(200)
      expect(await binary.json()).toEqual({
        path: "logo.png",
        body: null,
        binary: true,
      })
      expect(
        (await app.request("/workspaces/knowledge/files/blob?path=missing.md"))
          .status,
      ).toBe(404)
      expect(
        (await app.request("/workspaces/knowledge/files/blob?path=../secret"))
          .status,
      ).toBe(400)
    })
  },
)

it(
  "reports real sandbox edits and a clean status when no sandbox is attached",
  { timeout: 30_000 },
  async () => {
    await withFilesWorkspace(async ({ app, orgId, workspaceId, revision }) => {
      const clean = await app.request("/workspaces/knowledge/files/status")
      expect(clean.status).toBe(200)
      expect(await clean.json()).toEqual({
        sha: revision.sha,
        source: "clean",
        items: [],
      })
      const raw = await localProcessSandbox().create({ id: workspaceId })
      attachWorkspaceSandbox({
        id: workspaceId,
        kind: "job",
        workspaceId,
        orgId,
        handle: adaptTanstackHandle(raw),
        destroy: () => raw.destroy(),
      })
      try {
        await raw.process.exec(
          "git init -b main && git config user.name Contract && git config user.email contract@example.test",
        )
        await raw.fs.write("AGENTS.md", "# Published instructions\n")
        await raw.process.exec("git add . && git commit -m Published")
        await raw.fs.write("AGENTS.md", "# Edited instructions\n")
        await raw.fs.write("scratch.ts", "export {}\n")
        const dirty = await app.request("/workspaces/knowledge/files/status")
        expect(dirty.status).toBe(200)
        expect(await dirty.json()).toEqual({
          sha: revision.sha,
          source: "sandbox",
          items: [
            {
              path: "AGENTS.md",
              status: "modified",
              body: "# Edited instructions\n",
              additions: 1,
              deletions: 1,
            },
            {
              path: "scratch.ts",
              status: "untracked",
              body: "export {}\n",
              additions: 1,
              deletions: 0,
            },
          ],
        })
      } finally {
        await destroyWorkspaceSandbox(workspaceId, orgId)
      }
    })
  },
)

it(
  "rejects unpublished revisions, read-only edits, and paths outside the repository over HTTP",
  { timeout: 30_000 },
  async () => {
    await withFilesWorkspace(async ({ app, orgId, workspaceId }) => {
      const post = (body: object) =>
        app.request("/workspaces/knowledge/files/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      expect((await post({ op: "delete", path: "../secret" })).status).toBe(400)
      await withOrgDbContext(orgId, (db) =>
        db
          .update(workspaces)
          .set({ writeStatus: "read_only" })
          .where(eq(workspaces.id, workspaceId)),
      )
      const readonly = await post({
        op: "save",
        path: "AGENTS.md",
        content: "# saved\n",
      })
      expect(readonly.status).toBe(400)
      expect(await readonly.json()).toEqual({ error: "Workspace is read-only" })
      await withOrgDbContext(orgId, (db) =>
        db
          .update(workspaces)
          .set({ activeRevision: null })
          .where(eq(workspaces.id, workspaceId)),
      )
      for (const endpoint of ["tree", "blob?path=AGENTS.md"]) {
        const legacy = await app.request(
          `/workspaces/knowledge/files/${endpoint}`,
        )
        expect(legacy.status).toBe(409)
        expect(await legacy.json()).toEqual({
          error:
            "This Workspace must finish hydration before its published files can be browsed.",
        })
      }
      await withOrgDbContext(orgId, (db) =>
        db
          .update(workspaces)
          .set({
            activeProjectionSha: null,
            activeProjectionUrl: null,
            desiredSha: null,
          })
          .where(eq(workspaces.id, workspaceId)),
      )
      expect(
        (await app.request("/workspaces/knowledge/files/tree")).status,
      ).toBe(409)
      expect(
        (await app.request("/workspaces/knowledge/files/blob?path=AGENTS.md"))
          .status,
      ).toBe(409)
    })
  },
)

it(
  "durably queues a Files HTTP save with the literal edit payload",
  { timeout: 30_000 },
  async () => {
    const saved = {
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
    }
    const server = setupServer(
      http.post(
        "https://api.github.com/app/installations/123456790/access_tokens",
        () =>
          HttpResponse.json(
            {
              token: "fixture-files-write-token",
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
              permissions: { contents: "write", metadata: "read" },
            },
            { status: 201 },
          ),
      ),
      http.get("https://api.github.com/repos/fixture/files-contract", () =>
        HttpResponse.json({
          default_branch: "main",
          permissions: { push: true },
        }),
      ),
    )
    server.listen({ onUnhandledRequest: "error" })
    try {
      process.env.GITHUB_APP_ID = "12346"
      process.env.GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey
      await withFilesWorkspace(async ({ app, orgId, workspaceId }) => {
        const connectionId = `con_${workspaceId}`
        await withOrgDbContext(orgId, async (db) => {
          await db.insert(connections).values({
            id: connectionId,
            orgId,
            type: "github",
            config: {
              installationId: 123456790,
              ingestAllRepositories: false,
              includeFutureRepos: false,
            },
          })
          await db
            .update(workspaces)
            .set({
              workspaceRepositoryUrl:
                "https://github.com/fixture/files-contract",
              githubConnectionId: connectionId,
            })
            .where(eq(workspaces.id, workspaceId))
        })
        const queue = await BackendPostgres.connect(
          parseEnv(process.env).DATABASE_URL,
          { runMigrations: false },
        )
        try {
          const response = await app.request(
            "/workspaces/knowledge/files/jobs",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                op: "save",
                path: "AGENTS.md",
                content: "# Saved instructions\n",
              }),
            },
          )
          expect(response.status).toBe(202)
          expect(await response.json()).toEqual({ queued: true })
          await expect
            .poll(
              async () => {
                let after: string | undefined
                do {
                  const page = await queue.listWorkflowRuns({
                    limit: 100,
                    after,
                  })
                  const run = page.data.find(
                    (row) =>
                      row.input &&
                      typeof row.input === "object" &&
                      !Array.isArray(row.input) &&
                      row.input.workspaceId === workspaceId,
                  )
                  if (run) return run.input
                  after = page.pagination.next ?? undefined
                } while (after)
                return null
              },
              { timeout: 10_000 },
            )
            .toMatchObject({
              orgId,
              workspaceId,
              kind: "ui_file_edit",
              mergeFiles: [
                { path: "AGENTS.md", content: "# Saved instructions\n" },
              ],
              mergeDeletePaths: [],
            })
        } finally {
          await queue.stop()
        }
      })
    } finally {
      server.close()
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)
