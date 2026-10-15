import { HttpResponse, http } from "msw"
import { beforeAll, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { runSourceMigration } from "./migration.js"
import { FILE_ERROR_SOURCE_KEY } from "./projection-plan.js"
import {
  changeWorkspaceSource,
  listConnectionUsage,
  listWorkspaceSources,
} from "./service.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

/** An open pull request as GitHub lists it. */
function pull(number: number, branch: string) {
  return {
    number,
    html_url: `https://github.com/fixture/hydration-contract/pull/${number}`,
    head: { ref: branch },
    created_at: "2026-10-13T10:00:00Z",
  }
}

/**
 * GitHub's Git database API: every branch head is `parent`. Each write goes
 * into `writes`.
 */
function gitDatabase(
  parent: string,
  writes: Array<{ method: string; path: string; body: unknown }> = [],
) {
  return http.all(
    "https://api.github.com/repos/fixture/hydration-contract/git/*",
    async ({ request, params }) => {
      const path = String(params[0])
      if (request.method === "GET")
        return path.startsWith("ref/heads/")
          ? HttpResponse.json({ object: { sha: parent } })
          : HttpResponse.json({ tree: { sha: "b".repeat(40) } })
      writes.push({ method: request.method, path, body: await request.json() })
      return HttpResponse.json({ sha: "e".repeat(40) })
    },
  )
}

/** An installed Linear connection in the fixture org. */
async function addLinearConnection(f: NativeHydrationFixture): Promise<string> {
  const id = `con_linear_${f.id}`
  await withOrgDbContext(f.org.id, (db) =>
    db.insert(connections).values({
      id,
      orgId: f.org.id,
      type: "linear",
      config: {
        status: "installed",
        workspaceId: "linear-org",
        workspaceName: "Example",
      },
    }),
  )
  return id
}

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
        f.server.use(
          // No source pull request is open.
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
          gitDatabase(parent, gitWrites),
        )
        const linear = await addLinearConnection(f)

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
        const linear = await addLinearConnection(f)

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
        const linear = await addLinearConnection(f)
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

        const sources = await withOrgIdContext(f.org, async () => {
          const workspace = await getWorkspaceById(f.workspaceId)
          if (!workspace) throw new Error("Missing fixture Workspace")
          return listWorkspaceSources(workspace)
        })

        // "Used in" and the Sources settings show the same two.
        for (const pending of [
          usage?.items[0]?.pendingChanges,
          sources.pendingChanges,
        ])
          expect(
            pending?.map((change) => [change.action, change.sourceKey]),
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
          gitDatabase(parent),
          // A pull request that removes an earlier "linear" source is open.
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                pull(34, "ctxpipe/sources/remove/linear/linear-17918"),
              ]),
          ),
        )
        const linear = await addLinearConnection(f)

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

/** Add a Linear source in the fixture Workspace and return the result. */
async function addLinearSource(f: NativeHydrationFixture, linear: string) {
  return withOrgIdContext(f.org, async () => {
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
    })
  })
}

it(
  "skips the ids of open and of stale source pull requests for a new source",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        onGithubPullRequest: () => {},
      },
      async (f) => {
        f.server.use(
          gitDatabase("a".repeat(40)),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                // Open: a source "linear" exists, so this removal applies.
                pull(71, "ctxpipe/sources/remove/linear/linear-17918"),
                // Stale: no source "linear-2" exists, so it no longer applies.
                pull(72, "ctxpipe/sources/remove/linear/linear-2-17919"),
              ]),
          ),
        )
        const linear = await addLinearConnection(f)
        await replaceWorkspaceSourceRows({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision: f.sha,
          rows: [
            {
              sourceKey: "linear",
              provider: "linear",
              connectionId: linear,
              scope: { teams: ["ENG"] },
              status: "ok",
              statusDetail: null,
            },
          ],
        })

        const result = await addLinearSource(f, linear)

        expect(result).toMatchObject({ sourceKey: "linear-3" })
      },
    )
  },
)

it(
  "still adds a source when GitHub cannot list the pull requests",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        onGithubPullRequest: () => {},
      },
      async (f) => {
        f.server.use(
          gitDatabase("a".repeat(40)),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
          ),
        )
        const linear = await addLinearConnection(f)

        // The failed listing logs a warning, so the call needs a logger.
        const result = await withLogger(createLogger({}), () =>
          addLinearSource(f, linear),
        )

        expect(result).toMatchObject({
          outcome: "pull_request",
          sourceKey: "linear",
        })
      },
    )
  },
)

it(
  "shows every source pull request while the sources file cannot be read",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                // Each would be hidden if the file were readable.
                pull(81, "ctxpipe/sources/remove/linear/gone-1791887671414"),
                pull(82, "ctxpipe/sources/add/linear/eng-1791887671415"),
              ]),
          ),
        )
        const linear = await addLinearConnection(f)
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
            {
              sourceKey: FILE_ERROR_SOURCE_KEY,
              provider: null,
              connectionId: null,
              scope: {},
              status: "invalid",
              statusDetail: "The file is not valid YAML",
            },
          ],
        })

        const sources = await withOrgIdContext(f.org, async () => {
          const workspace = await getWorkspaceById(f.workspaceId)
          if (!workspace) throw new Error("Missing fixture Workspace")
          return listWorkspaceSources(workspace)
        })

        expect(
          sources.pendingChanges.map((c) => [c.action, c.sourceKey]),
        ).toEqual([
          ["remove", "gone"],
          ["add", "eng"],
        ])
      },
    )
  },
)

const sourcesFile = `version: 1
sources:
  - id: eng
    provider: linear
    connection: con_linear_existing
    teams: [ENG]
`

for (const change of ["edit", "remove"] as const)
  it(
    `opens a ${change} pull request from a ctxpipe/sources branch into the default branch`,
    { timeout: 60_000 },
    async () => {
      const pullRequests: unknown[] = []
      await withNativeHydrationFixture(
        {
          github: true,
          githubWriteView: "writable",
          writeStatus: "writable",
          githubContentFiles: { ".ctxpipe/sources.yaml": sourcesFile },
          onGithubPullRequest: (body) => {
            pullRequests.push(body)
          },
        },
        async (f) => {
          const linear = await addLinearConnection(f)
          f.server.use(
            http.get(
              "https://api.github.com/repos/fixture/hydration-contract/pulls",
              () => HttpResponse.json([]),
            ),
            gitDatabase("a".repeat(40)),
          )

          const result = await withOrgIdContext(f.org, async () => {
            const workspace = await getWorkspaceById(f.workspaceId)
            if (!workspace) throw new Error("Missing fixture Workspace")
            return changeWorkspaceSource({
              workspace,
              change:
                change === "edit"
                  ? {
                      action: "edit",
                      sourceKey: "eng",
                      provider: "linear",
                      connectionId: linear,
                      scope: { teams: ["OPS"] },
                    }
                  : { action: "remove", sourceKey: "eng" },
            })
          })

          expect(result).toMatchObject({ outcome: "pull_request" })
          expect(pullRequests).toEqual([
            expect.objectContaining({
              head: expect.stringMatching(
                new RegExp(`^ctxpipe/sources/${change}/linear/eng-`),
              ),
              base: "main",
            }),
          ])
        },
      )
    },
  )

it(
  "opens the source migration pull request from a new branch into the default branch",
  { timeout: 60_000 },
  async () => {
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
        const linear = await addLinearConnection(f)
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
          http.all(
            "https://api.github.com/repos/fixture/hydration-contract/git/*",
            ({ request, params }) => {
              const path = String(params[0])
              if (request.method === "GET" && path.startsWith("trees/"))
                return HttpResponse.json({ tree: [], truncated: false })
              if (request.method === "GET")
                return HttpResponse.json({
                  object: { sha: "a".repeat(40) },
                  tree: { sha: "b".repeat(40) },
                })
              return HttpResponse.json({ sha: "e".repeat(40) })
            },
          ),
        )

        const report = await withOrgIdContext(f.org, () =>
          runSourceMigration({
            orgId: f.org.id,
            env: parseEnv(process.env),
            apply: true,
            hooks: {
              linear: {
                provider: "linear",
                listLegacyBindings: async () => [
                  {
                    provider: "linear",
                    connectionId: linear,
                    syncRepositoryUrl:
                      "https://github.com/fixture/hydration-contract.git",
                    scope: { teams: ["ENG"] },
                  },
                ],
              },
            },
          }),
        )

        expect(report.failures).toEqual([])
        expect(pullRequests).toEqual([
          expect.objectContaining({
            head: expect.stringMatching(/^ctxpipe\/sources\/migrate-/),
            base: "main",
          }),
        ])
      },
    )
  },
)

it(
  "offers remove only for a row whose id a remove can name",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
        )
        const linear = await addLinearConnection(f)
        const invalid = {
          provider: null,
          connectionId: null,
          scope: {},
          status: "invalid" as const,
          statusDetail: "Not valid",
        }
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
            // An entry without a valid id, and a repository file that the
            // upgrade cannot move: neither has an id in the file.
            { ...invalid, sourceKey: ".entry-2" },
            { ...invalid, sourceKey: "repositories/tools.md" },
          ],
        })

        const sources = await withOrgIdContext(f.org, async () => {
          const workspace = await getWorkspaceById(f.workspaceId)
          if (!workspace) throw new Error("Missing fixture Workspace")
          return listWorkspaceSources(workspace)
        })

        expect(
          sources.items.map((item) => [item.sourceKey, item.removable]).sort(),
        ).toEqual([
          [".entry-2", false],
          ["eng", true],
          ["repositories/tools.md", false],
        ])
      },
    )
  },
)
