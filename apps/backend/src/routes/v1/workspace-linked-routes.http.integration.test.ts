import { OpenAPIHono } from "@hono/zod-openapi"
import { HttpResponse, http } from "msw"
import { beforeAll, expect, it } from "vitest"

import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { contextStorage } from "../../test/hono-test-logger.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { insertLinkedRepositoryRows } from "../../test/workspace-links-fixture.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

type GitWrite = { method: string; path: string; body: unknown }

/**
 * GitHub for the Workspace repository: `files` is each file on the default
 * branch, every branch head is `parent`, and each write goes into `writes`.
 */
function github(given: Record<string, string>, writes: GitWrite[]) {
  // The source writers read the format file on the default branch.
  const files: Record<string, string> = {
    ".ctxpipe/workspace.yaml": "format: 3\n",
    ...given,
  }
  const repo = "https://api.github.com/repos/fixture/hydration-contract"
  return [
    http.get(`${repo}/pulls`, () => HttpResponse.json([])),
    http.get(`${repo}/git/trees/:sha`, () =>
      HttpResponse.json({
        sha: "b".repeat(40),
        truncated: false,
        tree: Object.keys(files).map((path) => ({
          path,
          type: "blob",
          sha: "c".repeat(40),
        })),
      }),
    ),
    http.get(`${repo}/contents/*`, ({ params }) => {
      const content = files[String(params[0])]
      return content === undefined
        ? HttpResponse.json({ message: "Not found" }, { status: 404 })
        : HttpResponse.json({
            type: "file",
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
          })
    }),
    http.all(`${repo}/git/*`, async ({ request, params }) => {
      const path = String(params[0])
      if (request.method === "GET")
        return path.startsWith("ref/heads/")
          ? HttpResponse.json({ object: { sha: "a".repeat(40) } })
          : HttpResponse.json({ tree: { sha: "b".repeat(40) } })
      writes.push({ method: request.method, path, body: await request.json() })
      return HttpResponse.json({ sha: "e".repeat(40) })
    }),
  ]
}

async function unlink(f: NativeHydrationFixture, gitUrl: string) {
  const linkedId = `wlr_${f.id}`
  await withOrgDbContext(f.org.id, (db) =>
    insertLinkedRepositoryRows(db, {
      id: linkedId,
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      gitUrl,
    }),
  )
  const { workspaceLinkedRoutes } = await import("./workspace-linked-routes.js")
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
    c.set("session", { id: "sess_test" } as AppEnv["Variables"]["session"])
    return withOrgIdContext(f.org, () => next())
  })
  app.route("/:orgSlug/api/v1/workspaces", workspaceLinkedRoutes)
  return app.request(
    `/${f.org.slug}/api/v1/workspaces/knowledge/linked-repositories/${linkedId}`,
    { method: "DELETE" },
  )
}

/** Each tree entry that the writes of the pull request branch make. */
function treeEntries(writes: GitWrite[]) {
  return writes
    .filter((write) => write.method === "POST" && write.path === "trees")
    .flatMap((write) => (write.body as { tree: unknown[] }).tree)
}

it(
  "unlinks a repository by a pull request that deletes its source file",
  { timeout: 60_000 },
  async () => {
    const writes: GitWrite[] = []
    const pullRequests: Array<{ head?: string; base?: string }> = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        onGithubPullRequest: (body) => {
          pullRequests.push(body as { head?: string; base?: string })
        },
      },
      async (f) => {
        const main = () =>
          f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main")
        const before = main()
        f.server.use(
          ...github(
            {
              "sources/github/acme/team.md": `---\nprovider: github\nconnection: ${f.connectionId}\nrepository: acme/team\n---\n`,
              "sources/github/acme/web.md": `---\nprovider: github\nconnection: ${f.connectionId}\nrepository: acme/web\n---\n`,
              "notes.md": "Not a source.\n",
            },
            writes,
          ),
        )

        const response = await unlink(f, "https://github.com/acme/team")

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          outcome: "pull_request",
          path: "sources/github/acme/team.md",
          pullRequestUrl:
            "https://github.com/fixture/hydration-contract/pull/41",
        })
        expect(pullRequests).toEqual([
          expect.objectContaining({
            base: "main",
            head: expect.stringMatching(
              /^ctxpipe\/sources\/remove\/github\/acme\/team\/[a-z0-9]+-[a-f0-9]{8}$/,
            ),
          }),
        ])
        expect(treeEntries(writes)).toEqual([
          expect.objectContaining({
            path: "sources/github/acme/team.md",
            sha: null,
          }),
        ])
        // Nothing goes to the default branch: the pull request carries it.
        expect(writes.some((write) => write.path === "refs/heads/main")).toBe(
          false,
        )
        expect(main()).toBe(before)
      },
    )
  },
)

it(
  "unlinks a repository of the legacy sources file in the same pull request",
  { timeout: 60_000 },
  async () => {
    const writes: GitWrite[] = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        onGithubPullRequest: () => {},
      },
      async (f) => {
        f.server.use(
          ...github(
            {
              ".ctxpipe/sources.yaml": `version: 1\nsources:\n  - id: linked-repositories\n    provider: github\n    connection: "${f.connectionId}"\n    repositories: [acme/team, acme/web]\n`,
            },
            writes,
          ),
        )

        const response = await unlink(f, "https://github.com/acme/team")

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          outcome: "pull_request",
          pullRequestUrl: expect.stringMatching(/\/pull\/\d+$/),
        })
        const [yaml] = treeEntries(writes) as Array<{
          path: string
          content: string
        }>
        expect(yaml?.path).toBe(".ctxpipe/sources.yaml")
        expect(yaml?.content).toContain("acme/web")
        expect(yaml?.content).not.toContain("acme/team")
      },
    )
  },
)

it(
  "refuses an unlink when no file of the default branch links the repository",
  { timeout: 60_000 },
  async () => {
    const writes: GitWrite[] = []
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        f.server.use(...github({ "notes.md": "Not a source.\n" }, writes))

        const response = await unlink(f, "https://github.com/acme/team")

        expect(response.status).toBe(409)
        expect(writes).toEqual([])
      },
    )
  },
)
