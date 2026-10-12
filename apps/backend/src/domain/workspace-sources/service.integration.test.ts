import { HttpResponse, http } from "msw"
import { beforeAll, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { changeWorkspaceSource } from "./service.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

it(
  "opens a source change pull request from a new branch into the default branch",
  { timeout: 60_000 },
  async () => {
    const parent = "a".repeat(40)
    const gitWrites: Array<{ method: string; path: string; body: unknown }> = []
    const pullRequests: unknown[] = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        onGithubPullRequest: (body) => {
          pullRequests.push(body)
        },
      },
      async (f) => {
        // GitHub's Git database API: every branch head is `parent`.
        f.server.use(
          http.all(
            "https://api.github.com/repos/fixture/hydration-contract/git/*",
            async ({ request, params }) => {
              const path = String(params[0])
              if (request.method === "GET")
                return path.startsWith("ref/heads/")
                  ? HttpResponse.json({ object: { sha: parent } })
                  : HttpResponse.json({ tree: { sha: "b".repeat(40) } })
              gitWrites.push({
                method: request.method,
                path,
                body: await request.json(),
              })
              return HttpResponse.json({ sha: "e".repeat(40) })
            },
          ),
        )
        const linear = `con_linear_${f.id}`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(connections).values({
            id: linear,
            orgId: f.org.id,
            type: "linear",
            config: {
              status: "installed",
              workspaceId: "linear-org",
              workspaceName: "Example",
            },
          }),
        )

        const result = await withOrgIdContext(f.org, async () => {
          const workspace = await getWorkspaceById(f.workspaceId)
          if (!workspace) throw new Error("Missing fixture Workspace")
          return changeWorkspaceSource({
            workspace,
            change: {
              action: "add",
              sourceKey: "eng",
              provider: "linear",
              connectionId: linear,
              scope: { teams: ["ENG"] },
            },
            delivery: "pull_request",
          })
        })

        expect(result).toMatchObject({
          outcome: "pull_request",
          sourceKey: "eng",
          pullRequestUrl:
            "https://github.com/fixture/hydration-contract/pull/41",
        })
        const head = expect.stringMatching(
          /^ctxpipe\/sources\/add\/linear\/eng-/,
        )
        expect(pullRequests).toEqual([
          expect.objectContaining({ head, base: "main" }),
        ])
        expect(gitWrites).toContainEqual({
          method: "POST",
          path: "refs",
          body: {
            ref: expect.stringMatching(
              /^refs\/heads\/ctxpipe\/sources\/add\/linear\/eng-/,
            ),
            sha: parent,
          },
        })
        expect(gitWrites.filter((write) => write.method === "PATCH")).toEqual([
          expect.objectContaining({
            path: expect.stringMatching(
              /^refs\/heads\/ctxpipe\/sources\/add\/linear\/eng-/,
            ),
          }),
        ])
      },
    )
  },
)
