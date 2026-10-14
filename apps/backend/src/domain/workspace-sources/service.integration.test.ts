import { HttpResponse, http } from "msw"
import { beforeAll, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { changeWorkspaceSource, listConnectionUsage } from "./service.js"

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

it(
  "lists the open source pull requests of the connection's provider in Used in",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const pull = (number: number, branch: string) => ({
          number,
          html_url: `https://github.com/fixture/hydration-contract/pull/${number}`,
          head: { ref: branch },
          created_at: "2026-10-13T10:00:00Z",
        })
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                pull(51, "ctxpipe/sources/add/notion/docs-1791887671414"),
                pull(52, "ctxpipe/sources/add/linear/eng-1791887671415"),
                pull(53, "feature/unrelated"),
              ]),
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

        const usage = await withOrgIdContext(f.org, () =>
          listConnectionUsage(linear),
        )

        // The Workspace has no Linear source yet: only the pull request.
        expect(usage).toEqual({
          items: [
            expect.objectContaining({
              workspaceId: f.workspaceId,
              workspaceSlug: "knowledge",
              sources: [],
              pendingChanges: [
                {
                  sourceKey: "eng",
                  provider: "linear",
                  action: "add",
                  pullRequestUrl:
                    "https://github.com/fixture/hydration-contract/pull/52",
                  createdAt: "2026-10-13T10:00:00Z",
                },
              ],
            }),
          ],
        })
      },
    )
  },
)

it(
  "hides a source pull request whose change no longer applies to the default branch",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const pull = (number: number, branch: string) => ({
          number,
          html_url: `https://github.com/fixture/hydration-contract/pull/${number}`,
          head: { ref: branch },
          created_at: "2026-10-13T10:00:00Z",
        })
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                pull(61, "ctxpipe/sources/remove/linear/eng-1791887671414"),
                pull(62, "ctxpipe/sources/remove/linear/gone-1791887671415"),
                pull(63, "ctxpipe/sources/add/linear/eng-1791887671416"),
                pull(64, "ctxpipe/sources/add/linear/ops-1791887671417"),
              ]),
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
        // The default branch has the source "eng" and no source "gone".
        await replaceWorkspaceSourceRows({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision: f.sha,
          rows: [
            {
              sourceKey: "eng",
              provider: "linear",
              connectionId: linear,
              scope: { teams: ["ENG"] },
              status: "ok",
              statusDetail: null,
            },
          ],
        })

        const usage = await withOrgIdContext(f.org, () =>
          listConnectionUsage(linear),
        )

        expect(
          usage?.items[0]?.pendingChanges.map((change) => [
            change.action,
            change.sourceKey,
          ]),
        ).toEqual([
          ["remove", "eng"],
          ["add", "ops"],
        ])
      },
    )
  },
)

it(
  "gives a new source an id that no open source pull request uses",
  { timeout: 60_000 },
  async () => {
    const parent = "a".repeat(40)
    const pullRequests: Array<{ head?: string }> = []
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
          http.all(
            "https://api.github.com/repos/fixture/hydration-contract/git/*",
            async ({ request, params }) => {
              const path = String(params[0])
              if (request.method === "GET")
                return path.startsWith("ref/heads/")
                  ? HttpResponse.json({ object: { sha: parent } })
                  : HttpResponse.json({ tree: { sha: "b".repeat(40) } })
              return HttpResponse.json({ sha: "e".repeat(40) })
            },
          ),
          // A pull request that removes an earlier "linear" source is open.
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                {
                  number: 34,
                  html_url:
                    "https://github.com/fixture/hydration-contract/pull/34",
                  head: { ref: "ctxpipe/sources/remove/linear/linear-17918" },
                  created_at: "2026-10-13T04:07:54Z",
                },
              ]),
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
              provider: "linear",
              connectionId: linear,
              scope: { teams: ["CTX"] },
            },
            delivery: "pull_request",
          })
        })

        expect(result).toMatchObject({ sourceKey: "linear-2" })
        expect(pullRequests[0]?.head).toMatch(
          /^ctxpipe\/sources\/add\/linear\/linear-2-/,
        )
      },
    )
  },
)
