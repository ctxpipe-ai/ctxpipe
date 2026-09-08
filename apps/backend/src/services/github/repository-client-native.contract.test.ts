import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { getFileContentBytes } from "./installation-write-client.js"

it(
  "reads repository bytes using a repository-scoped read credential",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubContentFiles: { "config.yaml": "teams: []\n" } },
      async (f) => {
        const result = await withOrgIdContext(f.org, () =>
          getFileContentBytes({
            orgId: f.org.id,
            repositoryName: "fixture/hydration-contract",
            githubConnectionId: f.connectionId,
            env: parseEnv(process.env),
            branch: "main",
            path: "config.yaml",
          }),
        )
        expect(result).toEqual({
          kind: "bytes",
          bytes: Buffer.from("teams: []\n"),
        })
        expect(f.tokenRequests).toEqual([
          {
            repositories: ["hydration-contract"],
            permissions: { contents: "read", metadata: "read" },
          },
        ])
      },
    )
  },
)

it(
  "refuses the config API commit path when its target is the actual default branch",
  { timeout: 30_000 },
  async () => {
    const writes: string[] = []
    const parent = "a".repeat(40)
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        githubGitResponses: {
          [`GET commits/${parent}`]: {
            body: { tree: { sha: "b".repeat(40) } },
          },
          "POST blobs": { body: { sha: "c".repeat(40) } },
          "POST trees": { body: { sha: "d".repeat(40) } },
          "POST commits": { body: { sha: "e".repeat(40) } },
          "PATCH refs/heads/main": { body: {} },
        },
        onGithubGitRequest: (method, path) => {
          if (method !== "GET") writes.push(`${method} ${path}`)
        },
      },
      async (f) => {
        const { commitFiles } = await import("./installation-write-client.js")
        await expect(
          withOrgIdContext(f.org, () =>
            commitFiles({
              orgId: f.org.id,
              repositoryName: "fixture/hydration-contract",
              githubConnectionId: f.connectionId,
              env: parseEnv(process.env),
              branch: "main",
              expectedParentSha: parent,
              message: "Config update",
              files: [{ path: "config.yaml", content: "teams: []\n" }],
            }),
          ),
        ).rejects.toThrow(/default branch/i)
        expect(writes).toEqual([])
      },
    )
  },
)

it(
  "returns an empty tree without initializing the default branch during a read",
  { timeout: 60_000 },
  async () => {
    const writes: unknown[] = []
    const responses: Record<string, { status?: number; body: unknown }> = {
      "GET ref/heads/main": {
        status: 409,
        body: { message: "Git Repository is empty." },
      },
      [`GET commits/${"a".repeat(40)}`]: {
        body: { tree: { sha: "b".repeat(40) } },
      },
      [`GET trees/${"b".repeat(40)}`]: { body: { tree: [] } },
    }
    await withNativeHydrationFixture(
      {
        github: true,
        githubGitResponses: responses,
        onGithubContentsWrite: (path, body) => {
          writes.push({ path, body })
          responses["GET ref/heads/main"] = {
            body: { object: { sha: "a".repeat(40) } },
          }
        },
      },
      async (f) => {
        const { listFilesInTree } = await import(
          "./installation-write-client.js"
        )
        const result = await withOrgIdContext(f.org, () =>
          listFilesInTree({
            orgId: f.org.id,
            repositoryName: "fixture/hydration-contract",
            githubConnectionId: f.connectionId,
            env: parseEnv(process.env),
            branch: "main",
          }),
        ).catch(() => null)
        expect(writes).toEqual([])
        expect(result).toEqual([])
      },
    )
  },
)

it(
  "scopes MCP onboarding preview reads to each selected repository",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        githubContentFiles: { ".cursor/mcp.json": "{}" },
      },
      async (f) => {
        const { previewMcpConfigChanges } = await import(
          "../../models/github-mcp-config-pr.js"
        )
        const preview = await withOrgIdContext(f.org, () =>
          previewMcpConfigChanges({
            orgId: f.org.id,
            orgSlug: f.org.slug,
            githubConnectionId: f.connectionId,
            env: parseEnv(process.env),
            repositories: ["fixture/hydration-contract"],
            agents: ["cursor"],
          }),
        )
        expect(preview).toMatchObject([
          {
            repository: "fixture/hydration-contract",
            path: ".cursor/mcp.json",
            exists: true,
          },
        ])
        expect(f.tokenRequests).toEqual([
          {
            repositories: ["hydration-contract"],
            permissions: { contents: "read", metadata: "read" },
          },
        ])
      },
    )
  },
)

it(
  "refuses MCP config writes if its new branch becomes the default",
  { timeout: 30_000 },
  async () => {
    let defaultBranch = "main"
    const writes: unknown[] = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        githubDefaultBranch: () => defaultBranch,
        githubGitResponses: {
          "GET ref/heads/main": { body: { object: { sha: "a".repeat(40) } } },
          "POST refs": { body: {} },
        },
        onGithubGitRequest: (method, path, body) => {
          if (method === "POST" && path === "refs")
            defaultBranch = (body as { ref: string }).ref.replace(
              "refs/heads/",
              "",
            )
        },
        onGithubContentsWrite: (path, body) => writes.push({ path, body }),
        onGithubPullRequest: () => {},
      },
      async (f) => {
        const { createCtxpipeMcpConfigPullRequests } = await import(
          "../../models/github-mcp-config-pr.js"
        )
        const result = await withOrgIdContext(f.org, () =>
          createCtxpipeMcpConfigPullRequests({
            orgId: f.org.id,
            orgSlug: f.org.slug,
            githubConnectionId: f.connectionId,
            env: parseEnv(process.env),
            repositories: ["fixture/hydration-contract"],
            agents: ["cursor"],
          }),
        )
        expect(writes).toEqual([])
        expect(result.pullRequests).toEqual([])
        expect(result.failures).toEqual([
          expect.objectContaining({
            error: expect.stringMatching(/default branch/i),
          }),
        ])
      },
    )
  },
)

it.each(["feature", "advanced", "empty"])(
  "keeps config PR changes on a review branch: %s",
  { timeout: 60_000 },
  async (scenario) => {
    const parent = "a".repeat(40)
    const writes: Array<{ method: string; path: string; body: unknown }> = []
    const branch = "ctxpipe/config-review"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        githubGitResponses: {
          "GET ref/heads/main":
            scenario === "empty"
              ? { status: 409, body: { message: "Git Repository is empty." } }
              : { body: { object: { sha: parent } } },
          [`GET ref/heads/${branch}`]: { body: { object: { sha: parent } } },
          [`GET commits/${parent}`]: {
            body: { tree: { sha: "b".repeat(40) } },
          },
          "POST refs": { body: {} },
          "POST blobs": { body: { sha: "c".repeat(40) } },
          "POST trees": { body: { sha: "d".repeat(40) } },
          "POST commits": { body: { sha: "e".repeat(40) } },
          [`PATCH refs/heads/${branch}`]:
            scenario === "advanced"
              ? {
                  status: 422,
                  body: { message: "Update is not a fast forward" },
                }
              : { body: {} },
        },
        onGithubGitRequest: (method, path, body) => {
          if (method !== "GET") writes.push({ method, path, body })
        },
        onGithubPullRequest: () => {},
      },
      async (f) => {
        const { commitFiles, createPullRequestWithFiles } = await import(
          "./installation-write-client.js"
        )
        const input = {
          orgId: f.org.id,
          repositoryName: "fixture/hydration-contract",
          githubConnectionId: f.connectionId,
          env: parseEnv(process.env),
          branch,
          files: [{ path: "linear/config.yaml", content: "teams: []\n" }],
        }
        if (scenario === "advanced") {
          await expect(
            withOrgIdContext(f.org, () =>
              commitFiles({
                ...input,
                expectedParentSha: parent,
                message: "Config update",
              }),
            ),
          ).rejects.toMatchObject({ status: 422 })
          expect(
            writes.filter(
              (w) => w.path === "POST commits" || w.path === "commits",
            ),
          ).toEqual([
            expect.objectContaining({
              body: expect.objectContaining({ parents: [parent] }),
            }),
          ])
          expect(writes.filter((w) => w.method === "PATCH")).toEqual([
            {
              method: "PATCH",
              path: `refs/heads/${branch}`,
              body: { sha: "e".repeat(40) },
            },
          ])
        } else {
          const result = withOrgIdContext(f.org, () =>
            createPullRequestWithFiles({
              ...input,
              baseBranch: "main",
              title: "Configure Linear",
              body: "Review configuration",
              commitMessage: "Config update",
              requireNewBranch: true,
            }),
          )
          if (scenario === "empty") {
            await expect(result).rejects.toMatchObject({ status: 409 })
            expect(writes).toEqual([])
          } else {
            await expect(result).resolves.toMatchObject({
              pullNumber: 41,
              branch,
            })
            expect(writes.filter((w) => w.method === "PATCH")).toEqual([
              {
                method: "PATCH",
                path: `refs/heads/${branch}`,
                body: { sha: "e".repeat(40) },
              },
            ])
          }
        }
      },
    )
  },
)

it(
  "uses the stored repository binding for ingestion read credentials",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const { withOrgDbContext } = await import("../../db/client.js")
      const { repositories } = await import("../../db/schema/repositories.js")
      const { getRepositoryReadCloneToken } = await import(
        "../../models/github-installation.js"
      )
      const repositoryId = `repo_${f.id}`
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(repositories).values({
          id: repositoryId,
          orgId: f.org.id,
          name: "Bound repository",
          gitUrl: f.workspaceUrl,
          githubConnectionId: f.connectionId,
        }),
      )
      await expect(
        getRepositoryReadCloneToken(f.org.id, parseEnv(process.env), {
          repositoryId,
          githubConnectionId: "con_changed",
        }),
      ).rejects.toThrow(/connection changed/)
      expect(f.tokenRequests).toEqual([])
      await expect(
        getRepositoryReadCloneToken(f.org.id, parseEnv(process.env), {
          repositoryId,
        }),
      ).resolves.toBe("fixture-only-github-read-token")
      expect(f.tokenRequests).toEqual([
        {
          repositories: ["hydration-contract"],
          permissions: { contents: "read", metadata: "read" },
        },
      ])
    })
  },
)
