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
import type { SourceChange } from "./edit.js"
import { runSourceMigration } from "./migration.js"
import { FILE_ERROR_SOURCE_KEY } from "./projection-plan.js"
import {
  addWorkspaceSources,
  changeWorkspaceSource,
  findOpenAddPullRequest,
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

/**
 * GitHub's tree listing and file contents for the default branch: `files` is
 * every file of the Workspace repository, by path.
 */
function repositoryFiles(files: Record<string, string>) {
  return [
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/git/trees/:sha",
      () =>
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
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/contents/*",
      ({ params }) => {
        const content = files[String(params[0])]
        return content === undefined
          ? HttpResponse.json({ message: "Not found" }, { status: 404 })
          : HttpResponse.json({
              type: "file",
              encoding: "base64",
              content: Buffer.from(content).toString("base64"),
            })
      },
    ),
  ]
}

const linearFile = (connection: string, extra = "") =>
  `---\nprovider: linear\nconnection: ${connection}\nteams: [ENG]\n---\n${extra}`

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
          ...repositoryFiles({}),
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
              path: "sources/linear/eng.md",
              provider: "linear",
              connectionId: linear,
              scope: { teams: ["ENG"] },
            },
          })
        })

        expect(result).toMatchObject({
          outcome: "pull_request",
          path: "sources/linear/eng.md",
          pullRequestUrl:
            "https://github.com/fixture/hydration-contract/pull/41",
        })
        const head = expect.stringMatching(
          /^ctxpipe\/sources\/add\/linear\/eng\/[a-z0-9]+-[a-f0-9]{8}$/,
        )
        expect(pullRequests).toEqual([
          expect.objectContaining({ head, base: "main" }),
        ])
        expect(gitWrites).toContainEqual({
          method: "POST",
          path: "refs",
          body: {
            ref: expect.stringMatching(
              /^refs\/heads\/ctxpipe\/sources\/add\/linear\/eng\/[a-z0-9]+-[a-f0-9]{8}$/,
            ),
            sha: parent,
          },
        })
        expect(gitWrites.filter((write) => write.method === "PATCH")).toEqual([
          expect.objectContaining({
            path: expect.stringMatching(
              /^refs\/heads\/ctxpipe\/sources\/add\/linear\/eng\/[a-z0-9]+-[a-f0-9]{8}$/,
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
                pull(51, "ctxpipe/sources/add/notion/docs/k671414-0a1b2c3d"),
                pull(52, "ctxpipe/sources/add/linear/eng/k671415-0a1b2c3d"),
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
                  path: "sources/linear/eng.md",
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
                pull(61, "ctxpipe/sources/remove/linear/eng/k671414-0a1b2c3d"),
                pull(62, "ctxpipe/sources/remove/linear/gone/k671415-0a1b2c3d"),
                pull(63, "ctxpipe/sources/add/linear/eng/k671416-0a1b2c3d"),
                pull(64, "ctxpipe/sources/add/linear/ops/k671417-0a1b2c3d"),
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
              sourceKey: "sources/linear/eng.md",
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
            pending?.map((change) => [change.action, change.path]),
          ).toEqual([
            ["remove", "sources/linear/eng.md"],
            ["add", "sources/linear/ops.md"],
          ])
      },
    )
  },
)

it(
  "gives a new source a path that no open source pull request uses",
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
          ...repositoryFiles({}),
          gitDatabase(parent),
          // A pull request that removes an earlier "linear" source is open.
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                pull(
                  34,
                  "ctxpipe/sources/remove/linear/linear/k17918-0a1b2c3d",
                ),
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

        expect(result).toMatchObject({ path: "sources/linear/linear-2.md" })
        expect(pullRequests[0]?.head).toMatch(
          /^ctxpipe\/sources\/add\/linear\/linear-2\//,
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
  "skips the paths of existing files and of open and stale source pull requests for a new source",
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
          ...repositoryFiles({
            "sources/linear/linear.md": linearFile("con_linear_existing"),
          }),
          gitDatabase("a".repeat(40)),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                // Open: a source "linear" exists, so this removal applies.
                pull(
                  71,
                  "ctxpipe/sources/remove/linear/linear/k17918-0a1b2c3d",
                ),
                // Stale: no source "linear-2" exists, so it no longer applies.
                pull(
                  72,
                  "ctxpipe/sources/remove/linear/linear-2/k17919-0a1b2c3d",
                ),
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
              sourceKey: "sources/linear/linear.md",
              provider: "linear",
              connectionId: linear,
              scope: { teams: ["ENG"] },
              status: "ok",
              statusDetail: null,
            },
          ],
        })

        const result = await addLinearSource(f, linear)

        expect(result).toMatchObject({ path: "sources/linear/linear-3.md" })
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
          ...repositoryFiles({}),
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
          path: "sources/linear/linear.md",
        })
      },
    )
  },
)

it(
  "shows every source pull request while the legacy sources file cannot be read",
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
                pull(81, "ctxpipe/sources/remove/linear/gone/k671414-0a1b2c3d"),
                pull(82, "ctxpipe/sources/add/linear/eng/k671415-0a1b2c3d"),
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
              sourceKey: "sources/linear/eng.md",
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

        expect(sources.pendingChanges.map((c) => [c.action, c.path])).toEqual([
          ["remove", "sources/linear/gone.md"],
          ["add", "sources/linear/eng.md"],
        ])
      },
    )
  },
)

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
            ...repositoryFiles({
              "sources/linear/eng.md": linearFile(linear),
            }),
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
                      path: "sources/linear/eng.md",
                      provider: "linear",
                      connectionId: linear,
                      scope: { teams: ["OPS"] },
                    }
                  : { action: "remove", path: "sources/linear/eng.md" },
            })
          })

          expect(result).toMatchObject({ outcome: "pull_request" })
          expect(pullRequests).toEqual([
            expect.objectContaining({
              head: expect.stringMatching(
                new RegExp(
                  `^ctxpipe/sources/${change}/linear/eng/[a-z0-9]+-[a-f0-9]{8}$`,
                ),
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
  "offers remove only for a row whose source file a remove can name",
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
              sourceKey: "sources/linear/eng.md",
              provider: "linear",
              connectionId: linear,
              scope: { teams: ["ENG"] },
              status: "ok",
              statusDetail: null,
            },
            // An entry of the legacy file, and a repository file that the
            // upgrade cannot move: neither has a source file.
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
          sources.items.map((item) => [item.path, item.removable]).sort(),
        ).toEqual([
          [".entry-2", false],
          ["repositories/tools.md", false],
          ["sources/linear/eng.md", true],
        ])
      },
    )
  },
)

it(
  "renames a source file in a pull request as one move",
  { timeout: 60_000 },
  async () => {
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
        const linear = await addLinearConnection(f)
        const source = linearFile(linear, "Keep this body.\n")
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
          ...repositoryFiles({
            "sources/linear/eng.md": source,
            "linear/ENG-1.md":
              "---\nsources:\n  - sources/linear/eng.md\n---\nIssue.\n",
          }),
          gitDatabase("a".repeat(40), gitWrites),
        )

        const result = await withOrgIdContext(f.org, async () => {
          const workspace = await getWorkspaceById(f.workspaceId)
          if (!workspace) throw new Error("Missing fixture Workspace")
          return changeWorkspaceSource({
            workspace,
            change: {
              action: "rename",
              path: "sources/linear/eng.md",
              newPath: "sources/linear/engineering.md",
            },
          })
        })

        expect(result).toMatchObject({
          outcome: "pull_request",
          path: "sources/linear/engineering.md",
        })
        // The branch names both paths.
        expect(pullRequests).toEqual([
          expect.objectContaining({
            head: expect.stringMatching(
              /^ctxpipe\/sources\/rename\/linear\/eng\/_to_\/linear\/engineering\/[a-z0-9]+-[a-f0-9]{8}$/,
            ),
          }),
        ])
        const entries = gitWrites
          .filter((write) => write.method === "POST" && write.path === "trees")
          .flatMap((write) => (write.body as { tree: unknown[] }).tree)
        // The unit keeps the old path: the hydrate of the merged revision
        // changes its `sources` list.
        expect(entries).toHaveLength(2)
        expect(entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: "sources/linear/engineering.md",
              content: source,
            }),
            expect.objectContaining({
              path: "sources/linear/eng.md",
              sha: null,
            }),
          ]),
        )
      },
    )
  },
)

for (const action of ["add", "edit", "rename", "remove"] as const)
  it(
    `opens a pull request for a source ${action} with only its own files`,
    { timeout: 60_000 },
    async () => {
      const gitWrites: Array<{ method: string; path: string; body: unknown }> =
        []
      await withNativeHydrationFixture(
        {
          github: true,
          githubWriteView: "writable",
          writeStatus: "writable",
          onGithubPullRequest: () => {},
        },
        async (f) => {
          const linear = await addLinearConnection(f)
          f.server.use(
            http.get(
              "https://api.github.com/repos/fixture/hydration-contract/pulls",
              () => HttpResponse.json([]),
            ),
            ...repositoryFiles({
              "sources/linear/eng.md": linearFile(linear, "Body.\n"),
              "ENG-1.md": "---\nsources:\n  - sources/linear/eng.md\n---\n",
            }),
            gitDatabase("a".repeat(40), gitWrites),
          )
          const change = {
            add: {
              action: "add" as const,
              path: "sources/linear/ops.md",
              provider: "linear" as const,
              connectionId: linear,
              scope: { teams: ["OPS"] },
            },
            edit: {
              action: "edit" as const,
              path: "sources/linear/eng.md",
              provider: "linear" as const,
              connectionId: linear,
              scope: { teams: ["ENG", "OPS"] },
            },
            rename: {
              action: "rename" as const,
              path: "sources/linear/eng.md",
              newPath: "sources/linear/engineering.md",
            },
            remove: {
              action: "remove" as const,
              path: "sources/linear/eng.md",
            },
          }[action]

          const result = await withLogger(createLogger({}), () =>
            withOrgIdContext(f.org, async () => {
              const workspace = await getWorkspaceById(f.workspaceId)
              if (!workspace) throw new Error("Missing fixture Workspace")
              return changeWorkspaceSource({ workspace, change })
            }),
          )

          const expected = {
            add: { files: ["sources/linear/ops.md"], deletes: [] },
            edit: { files: ["sources/linear/eng.md"], deletes: [] },
            rename: {
              files: ["sources/linear/engineering.md"],
              deletes: ["sources/linear/eng.md"],
            },
            remove: { files: [], deletes: ["sources/linear/eng.md"] },
          }[action]
          expect(result).toMatchObject({ outcome: "pull_request" })
          const entries = gitWrites
            .filter(
              (write) => write.method === "POST" && write.path === "trees",
            )
            .flatMap(
              (write) =>
                (
                  write.body as {
                    tree: Array<{ path: string; sha?: null; content?: string }>
                  }
                ).tree,
            )
          expect(
            entries.filter((entry) => entry.sha === null).map((e) => e.path),
          ).toEqual(expected.deletes)
          expect(
            entries.filter((entry) => entry.sha !== null).map((e) => e.path),
          ).toEqual(expected.files)
          if (action === "edit")
            expect(entries[0]?.content).toMatch(/---\nBody\.\n$/)
        },
      )
    },
  )

it(
  "refuses a rename to a taken path and a path that an open pull request names",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const linear = await addLinearConnection(f)
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                // An open rename: neither its old nor its new path is free.
                pull(
                  91,
                  "ctxpipe/sources/rename/linear/eng/_to_/linear/team/k91-0a1b2c3d",
                ),
              ]),
          ),
          ...repositoryFiles({
            "sources/linear/eng.md": linearFile(linear),
            "sources/linear/ops.md": linearFile(linear),
          }),
          gitDatabase("a".repeat(40)),
        )
        const run = (change: SourceChange) =>
          withOrgIdContext(f.org, async () => {
            const workspace = await getWorkspaceById(f.workspaceId)
            if (!workspace) throw new Error("Missing fixture Workspace")
            return changeWorkspaceSource({
              workspace,
              change,
            })
          })
        const rename = (path: string, newPath: string) =>
          run({ action: "rename", path, newPath })

        await expect(
          rename("sources/linear/eng.md", "sources/linear/ops.md"),
        ).rejects.toMatchObject({ status: 409 })
        await expect(
          rename("sources/linear/ops.md", "sources/linear/team.md"),
        ).rejects.toMatchObject({ status: 409 })
        await expect(
          rename("sources/linear/nope.md", "sources/linear/x.md"),
        ).rejects.toMatchObject({ status: 404 })
        await expect(
          run({
            action: "add",
            path: "sources/linear/team.md",
            provider: "linear",
            connectionId: linear,
            scope: { teams: ["CTX"] },
          }),
        ).rejects.toMatchObject({ status: 409 })
      },
    )
  },
)

it(
  "refuses an add of a repository that the projection links, and reads no file list",
  { timeout: 60_000 },
  async () => {
    const reads: string[] = []
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        f.server.use(
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/git/trees/:sha",
            ({ request }) => {
              reads.push(request.url)
              return HttpResponse.json({ message: "Not used" }, { status: 500 })
            },
          ),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/contents/*",
            ({ params }) => {
              reads.push(String(params[0]))
              return HttpResponse.json(
                { message: "Not found" },
                { status: 404 },
              )
            },
          ),
          gitDatabase("a".repeat(40)),
        )
        // A legacy YAML entry links the repository; the default branch has
        // no source file for it.
        await replaceWorkspaceSourceRows({
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision: f.sha,
          rows: [
            {
              sourceKey: "linked-repositories",
              provider: "github",
              connectionId: f.connectionId,
              scope: { repositories: ["acme/web"] },
              status: "ok",
              statusDetail: null,
            },
          ],
        })

        await expect(
          withOrgIdContext(f.org, async () => {
            const workspace = await getWorkspaceById(f.workspaceId)
            if (!workspace) throw new Error("Missing fixture Workspace")
            return changeWorkspaceSource({
              workspace,
              change: {
                action: "add",
                provider: "github",
                connectionId: f.connectionId,
                scope: { repository: "Acme/Web" },
              },
            })
          }),
        ).rejects.toMatchObject({ status: 409 })
        // Only the path of the new file is read.
        expect(reads).toEqual(["sources/github/acme/web.md"])
      },
    )
  },
)

it(
  "adds several GitHub repositories in one pull request and lists each as pending",
  { timeout: 60_000 },
  async () => {
    const gitWrites: Array<{ method: string; path: string; body: unknown }> = []
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
          ...repositoryFiles({}),
          gitDatabase("a".repeat(40), gitWrites),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
        )
        const add = (repository: string) => ({
          action: "add" as const,
          provider: "github" as const,
          connectionId: f.connectionId,
          scope: { repository },
        })
        const run = (changes: ReturnType<typeof add>[]) =>
          withOrgIdContext(f.org, async () => {
            const workspace = await getWorkspaceById(f.workspaceId)
            if (!workspace) throw new Error("Missing fixture Workspace")
            return addWorkspaceSources({
              workspace,
              changes,
            })
          })

        const result = await run([add("acme/web"), add("acme/api")])

        expect(result).toMatchObject({
          outcome: "pull_request",
          paths: ["sources/github/acme/web.md", "sources/github/acme/api.md"],
        })
        expect(pullRequests).toHaveLength(1)
        expect(pullRequests[0]?.head).toMatch(
          /^ctxpipe\/sources\/add\/github\/acme\/web\/_and_\/github\/acme\/api\//,
        )
        const trees = gitWrites.filter((w) => w.path === "trees")
        expect(JSON.stringify(trees)).toContain("sources/github/acme/web.md")
        expect(JSON.stringify(trees)).toContain("sources/github/acme/api.md")

        // One refused add refuses the batch, and nothing more is opened.
        await expect(run([add("acme/web"), add("Acme/Web")])).rejects.toThrow(
          /already a source|exists/,
        )
        expect(pullRequests).toHaveLength(1)
      },
    )
  },
)

it(
  "lists each path of an open batch pull request as pending and refuses a later add of one",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        f.server.use(
          ...repositoryFiles({}),
          gitDatabase("a".repeat(40)),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                pull(
                  71,
                  "ctxpipe/sources/add/github/acme/web/_and_/github/acme/api/k71-0a1b2c3d",
                ),
              ]),
          ),
        )
        const inWorkspace = <T>(
          run: (
            workspace: NonNullable<
              Awaited<ReturnType<typeof getWorkspaceById>>
            >,
          ) => Promise<T>,
        ) =>
          withOrgIdContext(f.org, async () => {
            const workspace = await getWorkspaceById(f.workspaceId)
            if (!workspace) throw new Error("Missing fixture Workspace")
            return run(workspace)
          })

        const sources = await inWorkspace(listWorkspaceSources)

        expect(
          sources.pendingChanges.map((change) => [change.action, change.path]),
        ).toEqual([
          ["add", "sources/github/acme/web.md"],
          ["add", "sources/github/acme/api.md"],
        ])
        await expect(
          inWorkspace((workspace) =>
            changeWorkspaceSource({
              workspace,
              change: {
                action: "add",
                provider: "github",
                connectionId: f.connectionId,
                scope: { repository: "acme/api" },
              },
            }),
          ),
        ).rejects.toMatchObject({ status: 409 })
      },
    )
  },
)

it(
  "gives an auto path that no explicit path of the batch takes, and refuses a branch name over 200 characters",
  { timeout: 60_000 },
  async () => {
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
          ...repositoryFiles({}),
          gitDatabase("a".repeat(40)),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () => HttpResponse.json([]),
          ),
        )
        const linear = await addLinearConnection(f)
        const run = (
          changes: Parameters<typeof addWorkspaceSources>[0]["changes"],
        ) =>
          withOrgIdContext(f.org, async () => {
            const workspace = await getWorkspaceById(f.workspaceId)
            if (!workspace) throw new Error("Missing fixture Workspace")
            return addWorkspaceSources({ workspace, changes })
          })
        const team = (teams: string[], path?: string) => ({
          action: "add" as const,
          ...(path ? { path } : {}),
          provider: "linear" as const,
          connectionId: linear,
          scope: { teams },
        })

        const result = await run([
          team(["ENG"]),
          team(["OPS"], "sources/linear/linear.md"),
        ])

        expect(result.paths).toEqual([
          "sources/linear/linear-2.md",
          "sources/linear/linear.md",
        ])

        const repository = (index: number) => ({
          action: "add" as const,
          provider: "github" as const,
          connectionId: f.connectionId,
          scope: { repository: `acme/${"r".repeat(40)}-${index}` },
        })
        await expect(run([0, 1, 2, 3].map(repository))).rejects.toMatchObject({
          status: 400,
        })
        expect(pullRequests).toHaveLength(1)
      },
    )
  },
)

it(
  "finds the open pull request that adds one repository, and not another",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        f.server.use(
          ...repositoryFiles({}),
          gitDatabase("a".repeat(40)),
          http.get(
            "https://api.github.com/repos/fixture/hydration-contract/pulls",
            () =>
              HttpResponse.json([
                pull(71, "ctxpipe/sources/add/github/acme/web/k71-0a1b2c3d"),
              ]),
          ),
        )
        const find = (repositoryName: string) =>
          withOrgIdContext(f.org, async () => {
            const workspace = await getWorkspaceById(f.workspaceId)
            if (!workspace) throw new Error("Missing fixture Workspace")
            return findOpenAddPullRequest({ workspace, repositoryName })
          })

        await expect(find("acme/web")).resolves.toContain("/pull/71")
        await expect(find("acme/api")).resolves.toBeUndefined()
      },
    )
  },
)
