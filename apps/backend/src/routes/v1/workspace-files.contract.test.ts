import { withNativeIndexFixture } from "../../test/native-index-fixture.js"
import { generateKeyPairSync } from "node:crypto"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { BackendPostgres } from "openworkflow/postgres"
import { connections } from "../../db/schema/connections.js"
import { rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { adaptTanstackHandle } from "../../domain/workspaces/job-sandbox.js"
import {
  attachWorkspaceSandbox,
  destroyWorkspaceSandbox,
} from "../../domain/workspaces/sandbox-registry.js"
import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../../domain/workspaces/revision.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { workspaceFilesRoutes } from "./workspace-files-routes.js"

function filesApp(org: { id: string; slug: string; name: string }) {
  const env = parseEnv(process.env)
  const id = org.slug
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
  return app
}

async function withFilesWorkspace(
  run: (fixture: {
    app: OpenAPIHono<AppEnv>
    orgId: string
    workspaceId: string
    revision: WorkspaceRevision
    directory: string
  }) => Promise<void>,
) {
  await withNativeIndexFixture(
    async (f) => {
      await writeFile(join(f.remote, "AGENTS.md"), "# Future instructions\n")
      f.git("add", ".")
      f.git(
        "-c",
        "user.name=Contract",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "-m",
        "Future files",
      )
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({
            workspaceRepositoryUrl: "file:///unavailable-replacement.git",
            desiredGeneration: 2,
            desiredSha: f.git("rev-parse", "HEAD"),
            desiredDefaultBranch: "main",
            hydrateStatus: "pending",
            writeStatus: "writable",
          })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      await run({
        app: filesApp(f.org),
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        revision: f.revision,
        directory: f.directory,
      })
    },
    true,
    { "logo.png": Buffer.from("png\0bytes") },
  )
}

it(
  "serves the last indexed tree while the Workspace relinks",
  { timeout: 30_000 },
  async () => {
    await withFilesWorkspace(async ({ app, revision }) => {
      const response = await app.request("/workspaces/knowledge/files/tree")
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 200,
        body: {
          sha: revision.sha,
          paths: ["AGENTS.md", "logo.png", "sample.js"],
        },
      })
    })
  },
)

it.each([
  [
    "published text",
    "AGENTS.md",
    200,
    {
      path: "AGENTS.md",
      body: "# Revision search contract\nUse amberquartz instructions.\n",
      binary: false,
    },
  ],
  [
    "binary files",
    "logo.png",
    200,
    { path: "logo.png", body: null, binary: true },
  ],
  ["missing files", "missing.md", 404, { error: "Not found" }],
  [
    "path traversal",
    "../secret",
    400,
    { error: "A valid file path is required" },
  ],
])(
  "serves the indexed Files HTTP contract for %s",
  { timeout: 30_000 },
  async (_name, path, status, body) => {
    await withFilesWorkspace(async ({ app }) => {
      const response = await app.request(
        `/workspaces/knowledge/files/blob?path=${path}`,
      )
      expect({ status: response.status, body: await response.json() }).toEqual({
        status,
        body,
      })
    })
  },
)

it(
  "reports clean Files status when no sandbox is attached",
  { timeout: 30_000 },
  async () => {
    await withFilesWorkspace(async ({ app, revision }) => {
      const response = await app.request("/workspaces/knowledge/files/status")
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 200,
        body: { sha: revision.sha, source: "clean", items: [] },
      })
    })
  },
)

it(
  "reports real sandbox edits in Files status",
  { timeout: 30_000 },
  async () => {
    await withFilesWorkspace(async ({ app, orgId, workspaceId, revision }) => {
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
  "rejects Files write paths outside the repository",
  { timeout: 30_000 },
  async () => {
    await withFilesWorkspace(async ({ app }) => {
      const response = await app.request("/workspaces/knowledge/files/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "delete", path: "../secret" }),
      })
      expect(response.status).toBe(400)
    })
  },
)

it("rejects edits to a read-only Workspace", { timeout: 30_000 }, async () => {
  await withFilesWorkspace(async ({ app, orgId, workspaceId }) => {
    await withOrgDbContext(orgId, (db) =>
      db
        .update(workspaces)
        .set({ writeStatus: "read_only" })
        .where(eq(workspaces.id, workspaceId)),
    )
    const response = await app.request("/workspaces/knowledge/files/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "save",
        path: "AGENTS.md",
        content: "# saved\n",
      }),
    })
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 400,
      body: { error: "Workspace is read-only" },
    })
  })
})

it.each(["tree", "blob?path=AGENTS.md"])(
  "requires a published index for Files %s",
  { timeout: 30_000 },
  async (endpoint) => {
    await withNativeIndexFixture(async (f) => {
      const response = await filesApp(f.org).request(
        `/workspaces/knowledge/files/${endpoint}`,
      )
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 409,
        body: {
          error:
            "This Workspace must finish indexing before its published files can be browsed.",
        },
      })
    }, false)
  },
)

it.each(["tree", "blob?path=AGENTS.md"])(
  "requires reindexing legacy Files %s",
  { timeout: 30_000 },
  async (endpoint) => {
    await withFilesWorkspace(async ({ app, orgId, workspaceId }) => {
      await withOrgDbContext(orgId, (db) =>
        db
          .update(workspaces)
          .set({ activeRevision: null })
          .where(eq(workspaces.id, workspaceId)),
      )
      const response = await app.request(
        `/workspaces/knowledge/files/${endpoint}`,
      )
      expect(response.status).toBe(409)
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
    server.listen({
      onUnhandledRequest(request, print) {
        if (new URL(request.url).hostname !== "127.0.0.1") print.error()
      },
    })
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

it(
  "serves indexed Files bytes after the remote disappears",
  { timeout: 60_000 },
  async () => {
    await withNativeIndexFixture(async (f) => {
      await rename(f.remote, `${f.remote}-unavailable`)
      const response = await filesApp(f.org).request(
        "/workspaces/knowledge/files/blob?path=AGENTS.md",
      )
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 200,
        body: {
          path: "AGENTS.md",
          body: "# Revision search contract\nUse amberquartz instructions.\n",
          binary: false,
        },
      })
    })
  },
)

it(
  "serves an empty indexed file as an empty body",
  { timeout: 30_000 },
  async () => {
    await withNativeIndexFixture(
      async (f) => {
        const response = await filesApp(f.org).request(
          "/workspaces/knowledge/files/blob?path=empty.txt",
        )
        expect({
          status: response.status,
          body: await response.json(),
        }).toEqual({
          status: 200,
          body: { path: "empty.txt", body: "", binary: false },
        })
      },
      true,
      { "empty.txt": "" },
    )
  },
)
