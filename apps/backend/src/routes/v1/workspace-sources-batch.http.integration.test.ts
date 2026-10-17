import { OpenAPIHono } from "@hono/zod-openapi"
import { HttpResponse, http } from "msw"
import { beforeAll, expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { contextStorage } from "../../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

it(
  "maps each batch entry to one add and answers with the one pull request",
  { timeout: 60_000 },
  async () => {
    const pullRequests: Array<{ head?: string }> = []
    const trees: unknown[] = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        onGithubPullRequest: (body) => {
          pullRequests.push(body as { head?: string })
        },
      },
      async (f) => {
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/contents/*",
            ({ params }) =>
              // The source writers read the format file on the default branch.
              String(params[0]) === ".ctxpipe/workspace.yaml"
                ? HttpResponse.json({
                    type: "file",
                    encoding: "base64",
                    content: Buffer.from("format: 3\n").toString("base64"),
                  })
                : HttpResponse.json({ message: "Not found" }, { status: 404 }),
          ),
          http.all(
            "https://api.github.com/repos/fixture/hydration-contract/git/*",
            async ({ request, params }) => {
              const path = String(params[0])
              if (request.method === "GET")
                return path.startsWith("ref/heads/")
                  ? HttpResponse.json({ object: { sha: "a".repeat(40) } })
                  : HttpResponse.json({ tree: { sha: "b".repeat(40) } })
              const body = await request.json()
              if (path === "trees") trees.push(body)
              return HttpResponse.json({ sha: "e".repeat(40) })
            },
          ),
        )
        // The routes import the OpenWorkflow client, which reads DATABASE_URL on import.
        const { workspaceSourcesRoutes } = await import(
          "./workspace-sources-routes.js"
        )
        const { getWorkspaceById } = await import("../../models/workspaces.js")
        const workspace = await withOrgIdContext(f.org, () =>
          getWorkspaceById(f.workspaceId),
        )
        if (!workspace) throw new Error("Missing fixture Workspace")
        const app = new OpenAPIHono<AppEnv>()
        app.use(contextStorage())
        app.use("*", async (c, next) => {
          c.set("user", { id: "user_test" } as AppEnv["Variables"]["user"])
          c.set("session", {
            id: "sess_test",
          } as AppEnv["Variables"]["session"])
          return withOrgIdContext(f.org, () => next())
        })
        app.route("/:orgSlug/api/v1/workspaces", workspaceSourcesRoutes)

        const response = await app.request(
          `/${f.org.slug}/api/v1/workspaces/${workspace.slug}/sources/batch`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sources: [
                {
                  source: {
                    provider: "github",
                    connectionId: f.connectionId,
                    scope: { repository: "acme/web" },
                    description: "The web app.",
                  },
                },
                {
                  path: "sources/github/acme/backend.md",
                  source: {
                    provider: "github",
                    connectionId: f.connectionId,
                    scope: { repository: "acme/api" },
                  },
                },
              ],
            }),
          },
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          outcome: "pull_request",
          paths: [
            "sources/github/acme/web.md",
            "sources/github/acme/backend.md",
          ],
          pullRequestUrl: expect.stringMatching(/\/pull\/\d+$/),
        })
        expect(pullRequests).toHaveLength(1)
        const files = trees.flatMap(
          (tree) =>
            (tree as { tree: Array<{ path: string; content?: string }> }).tree,
        )
        expect(
          files.find((file) => file.path.endsWith("web.md"))?.content,
        ).toMatch(
          /^---\n[\s\S]*repository: acme\/web[\s\S]*---\nThe web app\.\n$/,
        )
        expect(
          files.find((file) => file.path.endsWith("backend.md"))?.content,
        ).toMatch(/repository: acme\/api/)
      },
    )
  },
)
