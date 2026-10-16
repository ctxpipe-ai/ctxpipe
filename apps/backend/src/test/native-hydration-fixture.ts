import { execFileSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { FalkorDB } from "falkordb"
import { HttpResponse, http, passthrough } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { connectionDirectory, connections } from "../db/schema/connections.js"
import { repositories } from "../db/schema/repositories.js"
import { orgFirstWorkspaces, workspaces } from "../db/schema/workspaces.js"
import { resolveWorkspaceReadRevision } from "../domain/workspaces/resolve-revision.js"
import type { GithubRepoPermissionBits } from "../domain/workspaces/write-status.js"
import { invalidateGithubAppCacheForConnection } from "../models/github-installation.js"
import {
  getWorkspaceProjection,
  persistWorkspaceIndexResult,
} from "../models/workspaces.js"
import { repositoryIndex } from "../openworkflow/workflows/repository-index.js"
import { workspaceHydrate } from "../openworkflow/workflows/workspace-hydrate.js"
import { workspaceIndex } from "../openworkflow/workflows/workspace-index.js"
import { workspaceTipCheck } from "../openworkflow/workflows/workspace-tip-check.js"
import { closeGraphDb } from "../platform/graph/client.js"
import { listenWithDockerOutsideMsw } from "./docker-outside-msw.js"

export type NativeHydrationOptions = {
  namespaceId?: string
  files?: Array<{ path: string; body: string; mode?: "100755" | "120000" }>
  initialCommitDate?: string
  semanticMergeResolution?: {
    files: Array<{ path: string; content: string | null }>
  }
  semanticMergeDelayMs?: number
  /** The model's tool-call arguments for the AGENTS.md folder-list step. */
  folderListReply?: Record<string, unknown>
  /**
   * A real chat agent (OpenCode) runs against this fixture: streamed model
   * requests get a short streamed reply, and loopback HTTP (the agent, the
   * model proxy, the Docker daemon) is not intercepted.
   */
  chatAgent?:
    | boolean
    | {
        /**
         * The model's next step for a streamed request: a reply, or one tool
         * call by the name the agent offered (e.g. `bash`).
         */
        next: (request: {
          messages: Array<{ role: string }>
          tools: string[]
        }) => { text: string } | { tool: string; args: Record<string, unknown> }
      }
  count?: number
  /** The Workspace root folder (CTX-709); the repository root when absent. */
  rootPath?: string
  traceGitCommands?: boolean
  github?: boolean
  githubWriteView?: "writable" | "missing"
  githubDefaultBranch?: () => string
  githubRepoPermissions?: GithubRepoPermissionBits | null
  githubInstallationPermissions?: GithubRepoPermissionBits
  githubContentFiles?: Record<string, string>
  githubPullRequest?: {
    number: number
    head: { ref: string; sha?: string }
    state: string
    html_url: string
  }
  onGithubPullRequestUpdate?: (body: unknown) => void | Promise<void>
  onGithubPullRequestRead?: () => void | Promise<void>
  onGithubPrCredential?: () => void | Promise<void>
  onGithubPullRequest?: (body: unknown) => void | Promise<void>
  /** GitHub's compare answers 404 while this returns true. */
  githubCompareRefused?: () => boolean
  githubGitResponses?: Record<string, { status?: number; body: unknown }>
  onGithubRequest?: (method: string, url: string) => void
  onGithubGitRequest?: (method: string, path: string, body: unknown) => void
  onGithubContentsWrite?: (path: string, body: unknown) => void
  githubListCommits?:
    | "fail"
    | "missing"
    | Array<{
        sha: string
        message: string
        authorName: string
        /** The GitHub login. Default: `authorName`. `null`: no GitHub user. */
        authorLogin?: string | null
        date: string
        htmlUrl?: string
      }>
  /** Called on each request of the GitHub commit list. */
  onGithubListCommits?: () => void
  slackCaptureIntent?: boolean
  slackResponses?: Record<string, unknown>
  onSlackRequest?: (method: string, body: unknown) => void
  pagerdutyResponses?: Record<string, { status?: number; body?: unknown }>
  confluenceResponses?: Record<string, { status?: number; body: unknown }>
  embeddings?: "ready" | "failed" | "empty"
  missingTip?: boolean
  writeStatus?: "read_only" | "writable"
}

async function createNativeHydrationFixture(
  options: NativeHydrationOptions = {},
) {
  const { github = false, writeStatus, missingTip = false } = options
  const count = options.files?.length ?? options.count ?? 1
  const embeddingFailure = options.embeddings === "failed"
  const incompleteEmbeddings = options.embeddings === "empty"
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for hydration proof")
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-hydration-contract-"))
  const id = `hydrate_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const org = { id: `org_${id}`, slug: id, name: "Hydration contract" }
  const workspaceId = `ws_${id}`
  const connectionId = `con_${id}`
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
  const savedEnv = {
    GIT_TRACE2_EVENT: process.env.GIT_TRACE2_EVENT,
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
    SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER,
    MODEL_PROVIDER: process.env.MODEL_PROVIDER,
    MODEL_PROVIDER_API_KEY: process.env.MODEL_PROVIDER_API_KEY,
    MODEL_PROVIDER_URL: process.env.MODEL_PROVIDER_URL,
  }
  Object.assign(process.env, {
    ...(options.semanticMergeResolution
      ? { SANDBOX_PROVIDER: "unsandboxed" }
      : {}),
    MODEL_PROVIDER: "openai-like",
    MODEL_PROVIDER_API_KEY: "fixture-only",
    MODEL_PROVIDER_URL: "https://hydrate-model.test/v1",
  })
  const semanticRequests: unknown[] = []
  const tokenRequests: unknown[] = []
  const appPermissionRequests: { usesAppAuth: boolean }[] = []
  let failEmbeddings = embeddingFailure === true
  let failGithubTokens: number | false = false
  let githubWriteView = options.githubWriteView
  // GitHub gives each repository a numeric id. A repository-scoped token mint
  // and the repository read return the same id.
  const githubRepositoryIds = new Map<string, number>()
  const githubRepositoryId = (name: string) => {
    const known = githubRepositoryIds.get(name)
    if (known !== undefined) return known
    const id = 700_000 + githubRepositoryIds.size
    githubRepositoryIds.set(name, id)
    return id
  }
  let beforeWriteProbe: (() => Promise<void>) | undefined
  let beforeWriteCredential: (() => Promise<void>) | undefined
  const server = setupServer(
    ...(options.chatAgent
      ? [
          http.all(/^http:\/\/(127\.0\.0\.1|localhost)[:/]/, () =>
            passthrough(),
          ),
        ]
      : []),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/pulls/:number/files",
      () => HttpResponse.json([]),
    ),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/pulls/:number/reviews",
      () => HttpResponse.json([]),
    ),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/pulls/:number/comments",
      () => HttpResponse.json([]),
    ),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/issues/:number/comments",
      () => HttpResponse.json([]),
    ),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/pulls/:number",
      async () => {
        await options.onGithubPullRequestRead?.()
        return HttpResponse.json(
          options.githubPullRequest ?? { message: "Not found" },
          { status: options.githubPullRequest ? 200 : 404 },
        )
      },
    ),
    // GitHub's compare, answered from the fixture's real remote.
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/compare/:basehead",
      ({ params }) => {
        if (options.githubCompareRefused?.())
          return HttpResponse.json({ message: "Not Found" }, { status: 404 })
        const [base, head] = String(params.basehead).split("...")
        const remote = (...args: string[]) =>
          git("--git-dir", join(directory, "remote.git"), ...args)
        const range = `${base}...${head}`
        const statuses: Record<string, string> = {
          A: "added",
          M: "modified",
          D: "removed",
        }
        return HttpResponse.json({
          commits: remote(
            "log",
            "--reverse",
            "--format=%B%x00",
            `${base}..${head}`,
          )
            .split("\0")
            .map((message) => message.trim())
            .filter(Boolean)
            .map((message) => ({ commit: { message } })),
          files: remote("diff", "--name-status", range)
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [status = "", filename = ""] = line.split("\t")
              return { filename, status: statuses[status] ?? "changed" }
            }),
        })
      },
    ),
    http.put(
      "https://api.github.com/repos/fixture/hydration-contract/contents/*",
      async ({ request, params }) => {
        if (!options.onGithubContentsWrite)
          return HttpResponse.json(
            { message: "Unexpected contents write" },
            { status: 400 },
          )
        options.onGithubContentsWrite(String(params[0]), await request.json())
        return HttpResponse.json(
          { content: { sha: "c".repeat(40) } },
          { status: 201 },
        )
      },
    ),
    ...(options.githubGitResponses
      ? [
          http.all(
            "https://api.github.com/repos/fixture/hydration-contract/git/*",
            async ({ request, params }) => {
              const path = String(params[0])
              const body =
                request.method === "GET" ? undefined : await request.json()
              options.onGithubGitRequest?.(request.method, path, body)
              const response =
                options.githubGitResponses?.[`${request.method} ${path}`]
              return HttpResponse.json(
                response?.body ?? { message: "Unexpected GitHub Git request" },
                { status: response?.status ?? (response ? 200 : 400) },
              )
            },
          ),
        ]
      : []),
    http.patch(
      "https://api.github.com/repos/fixture/hydration-contract/pulls/:number",
      async ({ request }) => {
        if (!options.onGithubPullRequestUpdate)
          return HttpResponse.json(
            { message: "Unexpected pull update" },
            { status: 400 },
          )
        const body = await request.json()
        await options.onGithubPullRequestUpdate(body)
        return HttpResponse.json({ number: 41, ...(body as object) })
      },
    ),
    http.post(
      "https://api.github.com/repos/fixture/hydration-contract/issues/:number/comments",
      () =>
        HttpResponse.json(
          {},
          { status: options.onGithubPullRequestUpdate ? 201 : 400 },
        ),
    ),
    http.post(
      "https://api.github.com/repos/fixture/hydration-contract/pulls",
      async ({ request }) => {
        if (!options.onGithubPullRequest)
          return HttpResponse.json(
            { message: "Unexpected pull request" },
            { status: 400 },
          )
        // GitHub reads both branches with the caller's token. A token without
        // Contents permission cannot read them.
        if (
          request.headers
            .get("authorization")
            ?.includes("fixture-only-github-no-contents-token")
        )
          return HttpResponse.json(
            {
              message: "Validation Failed",
              errors: [
                {
                  resource: "PullRequest",
                  code: "custom",
                  message: "not all refs are readable",
                },
              ],
            },
            { status: 422 },
          )
        await options.onGithubPullRequest(await request.json())
        return HttpResponse.json(
          {
            number: 41,
            html_url: "https://github.com/fixture/hydration-contract/pull/41",
            state: "open",
          },
          { status: 201 },
        )
      },
    ),
    http.delete(
      "https://api.github.com/installation/token",
      () => new HttpResponse(null, { status: 204 }),
    ),
    http.post(
      "https://api.github.com/app/installations/123456789/access_tokens",
      async ({ request }) => {
        const body = await request.text()
        const requestBody = body ? JSON.parse(body) : {}
        tokenRequests.push(requestBody)
        if (requestBody.permissions?.pull_requests === "write")
          await options.onGithubPrCredential?.()
        const writing = requestBody.permissions?.contents === "write"
        // GitHub grants only the permissions the request names.
        const reading =
          !requestBody.permissions || Boolean(requestBody.permissions.contents)
        if (writing) await beforeWriteCredential?.()
        if (failGithubTokens)
          return HttpResponse.json(
            { message: "Credential provider unavailable" },
            { status: failGithubTokens },
          )
        return HttpResponse.json(
          {
            token: writing
              ? "fixture-only-github-write-token"
              : reading
                ? "fixture-only-github-read-token"
                : "fixture-only-github-no-contents-token",
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            permissions: {
              ...(reading ? { contents: writing ? "write" : "read" } : {}),
              metadata: "read",
            },
            ...(Array.isArray(requestBody.repositories)
              ? {
                  repositories: requestBody.repositories.map(
                    (name: string) => ({
                      id: githubRepositoryId(name),
                      full_name: `fixture/${name}`,
                    }),
                  ),
                }
              : {}),
          },
          { status: 201 },
        )
      },
    ),
    http.get(
      "https://api.github.com/repos/fixture/:repo",
      async ({ params }) => {
        await beforeWriteProbe?.()
        const name = String(params.repo)
        return githubWriteView === "writable"
          ? HttpResponse.json({
              id: githubRepositoryId(name),
              full_name: `fixture/${name}`,
              default_branch: options.githubDefaultBranch?.() ?? "main",
              ...(options.githubRepoPermissions === null
                ? {}
                : {
                    permissions: options.githubRepoPermissions ?? {
                      push: true,
                    },
                  }),
            })
          : HttpResponse.json({ message: "Use native Git" }, { status: 404 })
      },
    ),
    // The fixture GitHub App: it authors the pull requests that ctx| opens.
    http.get("https://api.github.com/app", () =>
      HttpResponse.json({ id: 12345, slug: "ctxpipe-fixture" }),
    ),
    http.get(
      "https://api.github.com/app/installations/123456789",
      ({ request }) => {
        appPermissionRequests.push({
          usesAppAuth: /^bearer [^.]+\.[^.]+\.[^.]+$/i.test(
            request.headers.get("authorization") ?? "",
          ),
        })
        return HttpResponse.json({
          permissions: options.githubInstallationPermissions ?? {
            contents: "read",
          },
        })
      },
    ),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/commits",
      ({ request }) => {
        options.onGithubListCommits?.()
        if (options.githubListCommits === "missing") {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 })
        }
        if (options.githubListCommits === "fail") {
          return HttpResponse.json(
            { message: "GitHub commit list unavailable" },
            { status: 500 },
          )
        }
        // Page like GitHub: `page` (from 1) and `per_page`.
        const params = new URL(request.url).searchParams
        const perPage = Number(params.get("per_page") ?? 30)
        const start = (Number(params.get("page") ?? 1) - 1) * perPage
        return HttpResponse.json(
          (options.githubListCommits ?? [])
            .slice(start, start + perPage)
            .map((commit) => ({
              sha: commit.sha,
              html_url:
                commit.htmlUrl ??
                `https://github.com/fixture/hydration-contract/commit/${commit.sha}`,
              commit: {
                message: commit.message,
                author: { name: commit.authorName, date: commit.date },
                committer: { date: commit.date },
              },
              author:
                commit.authorLogin === null
                  ? null
                  : { login: commit.authorLogin ?? commit.authorName },
            })),
        )
      },
    ),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/git/ref/*",
      () =>
        HttpResponse.json(
          { message: "Native Git is required for fixture writes" },
          { status: 403 },
        ),
    ),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/git/trees/:sha",
      () => HttpResponse.json({ message: "Use native Git" }, { status: 404 }),
    ),
    http.get(
      "https://api.github.com/repos/fixture/hydration-contract/contents/*",
      ({ params }) => {
        const content = options.githubContentFiles?.[String(params[0])]
        return content === undefined
          ? HttpResponse.json({ message: "Not found" }, { status: 404 })
          : HttpResponse.json({
              type: "file",
              encoding: "base64",
              content: Buffer.from(content).toString("base64"),
            })
      },
    ),
    http.all("https://api.pagerduty.com/*", ({ request }) => {
      const path = new URL(request.url).pathname
      const response = options.pagerdutyResponses?.[path]
      return HttpResponse.json(response?.body ?? { error: "Not Found" }, {
        status: response?.status ?? (response ? 200 : 404),
      })
    }),
    http.all("https://api.eu.pagerduty.com/*", ({ request }) => {
      const path = new URL(request.url).pathname
      const response = options.pagerdutyResponses?.[path]
      return HttpResponse.json(response?.body ?? { error: "Not Found" }, {
        status: response?.status ?? (response ? 200 : 404),
      })
    }),
    http.all("https://slack.com/api/:method", async ({ params, request }) => {
      const method = String(params.method)
      options.onSlackRequest?.(
        method,
        request.method === "POST" ? await request.json() : undefined,
      )
      return HttpResponse.json(
        options.slackResponses?.[method] ?? {
          ok: false,
          error: "fixture_unhandled",
        },
      )
    }),
    http.get(
      "https://api.atlassian.com/ex/confluence/fixture-cloud/*",
      ({ params }) => {
        const response = options.confluenceResponses?.[String(params[0])]
        return HttpResponse.json(response?.body ?? { message: "Not found" }, {
          status: response?.status ?? (response ? 200 : 404),
        })
      },
    ),
    http.post(
      "https://hydrate-model.test/v1/chat/completions",
      async ({ request }) => {
        const body = (await request.json()) as {
          messages?: Array<{ role: string }>
          tools?: Array<{ function: { name: string } }>
          stream?: boolean
          model?: string
        }
        if (options.chatAgent && body.stream) {
          const step =
            typeof options.chatAgent === "object"
              ? options.chatAgent.next({
                  messages: body.messages ?? [],
                  tools: (body.tools ?? []).map((tool) => tool.function.name),
                })
              : { text: "Fixture reply." }
          const choices =
            "tool" in step
              ? [
                  {
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${body.messages?.length ?? 0}`,
                          type: "function",
                          function: {
                            name: step.tool,
                            arguments: JSON.stringify(step.args),
                          },
                        },
                      ],
                    },
                  },
                  { delta: {}, finish_reason: "tool_calls" },
                ]
              : [
                  { delta: { role: "assistant", content: step.text } },
                  { delta: {}, finish_reason: "stop" },
                ]
          return new HttpResponse(
            choices
              .map(
                (choice) =>
                  `data: ${JSON.stringify({ id: "fixture-chat", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, finish_reason: null, ...choice }] })}\n\n`,
              )
              .join("")
              .concat("data: [DONE]\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        const tool = body.tools?.[0]?.function.name
        // The Slack mention agent forces one structured `mention_intent` call.
        const mentionIntent =
          tool === "mention_intent"
            ? { capture: options.slackCaptureIntent === true }
            : undefined
        const folderList =
          tool === "agents_md_folder_list" ? options.folderListReply : undefined
        if (tool) semanticRequests.push(body)
        if (tool && options.semanticMergeDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, options.semanticMergeDelayMs),
          )
        return HttpResponse.json({
          id: "fixture-model",
          object: "chat.completion",
          created: 1,
          model: "fixture",
          choices: [
            {
              index: 0,
              message:
                mentionIntent ||
                folderList ||
                (tool && options.semanticMergeResolution)
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "fixture-merge",
                          type: "function",
                          function: {
                            name: tool,
                            arguments: JSON.stringify(
                              mentionIntent ??
                                folderList ??
                                options.semanticMergeResolution,
                            ),
                          },
                        },
                      ],
                    }
                  : {
                      role: "assistant",
                      content: "ctxpipe - Bootstrap workspace knowledge",
                    },
              finish_reason: tool ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    ),
    http.post(
      "https://hydrate-model.test/v1/embeddings",
      async ({ request }) => {
        if (failEmbeddings)
          return HttpResponse.json(
            { error: { message: "Embedding fixture unavailable" } },
            { status: 400 },
          )
        const body = (await request.json()) as { input: string[] }
        return HttpResponse.json({
          data: body.input.map((_, index) => ({
            index,
            embedding: incompleteEmbeddings ? [] : Array(2000).fill(0.01),
          })),
        })
      },
    ),
  )
  server.events.on("request:start", ({ request }) => {
    if (new URL(request.url).hostname === "api.github.com")
      options.onGithubRequest?.(request.method, request.url)
  })
  listenWithDockerOutsideMsw(server, { onUnhandledRequest: "error" })
  initDb(databaseUrl)
  const backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: options.namespaceId ?? id,
  })
  const runner = new OpenWorkflow({ backend })
  runner.implementWorkflow(workspaceTipCheck.spec, workspaceTipCheck.fn)
  runner.implementWorkflow(workspaceHydrate.spec, workspaceHydrate.fn)
  runner.implementWorkflow(workspaceIndex.spec, workspaceIndex.fn)
  runner.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
  const worker = runner.newWorker({ concurrency: 2 })
  const gitTrace = join(tmpdir(), `ctxpipe-hydration-trace-${id}.jsonl`)
  // Outside the fixture worktree, so that a later commit cannot add it.
  const gitShim = mkdtempSync(join(tmpdir(), "ctxpipe-hydration-git-shim-"))

  let cleanupPromise: Promise<void> | undefined
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      await worker.stop()
      await backend.stop()
      try {
        await getSystemDb().execute(
          sql`delete from openworkflow.workflow_runs where namespace_id = ${id} or input->>'orgId' = ${org.id}`,
        )
        await withOrgDbContext(org.id, async (db) => {
          await db
            .delete(orgFirstWorkspaces)
            .where(eq(orgFirstWorkspaces.orgId, org.id))
          await db.delete(repositories).where(eq(repositories.orgId, org.id))
          await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
          await db.delete(connections).where(eq(connections.id, connectionId))
        })
        await getSystemDb()
          .delete(connectionDirectory)
          .where(eq(connectionDirectory.orgId, org.id))
        await getSystemDb()
          .delete(organizations)
          .where(eq(organizations.id, org.id))
      } finally {
        await closeGraphDb()
        if (process.env.GRAPH_DB_URI) {
          const graphDb = await FalkorDB.connect({
            url: process.env.GRAPH_DB_URI,
          })
          try {
            if ((await graphDb.list()).includes(org.id))
              await graphDb.selectGraph(org.id).delete()
          } finally {
            await graphDb.close()
          }
        }
        await closeDb()
        invalidateGithubAppCacheForConnection(connectionId)
        server.close()
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        rmSync(gitTrace, { force: true })
        rmSync(gitShim, { recursive: true, force: true })
        rmSync(directory, { recursive: true, force: true })
      }
    })())
  try {
    git("init", "-b", "main")
    git("config", "user.name", "Contract")
    git("config", "user.email", "contract@example.test")
    const expected =
      options.files ??
      Array.from({ length: count }, (_, index) => ({
        path: `document-${String(index).padStart(3, "0")}.md`,
        body: `# Document ${index}\nCommitted body ${index}.\n`,
      }))
    for (const file of expected) {
      mkdirSync(dirname(join(directory, file.path)), { recursive: true })
      // `{{connectionId}}` stands for the fixture's GitHub connection id.
      writeFileSync(
        join(directory, file.path),
        file.body.replaceAll("{{connectionId}}", connectionId),
      )
    }
    git("add", ".")
    for (const file of options.files ?? []) {
      if (file.mode) {
        const blob = git("rev-parse", `:${file.path}`)
        git("update-index", "--cacheinfo", `${file.mode},${blob},${file.path}`)
      }
    }
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Contract",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Immutable fixture",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(options.initialCommitDate
            ? {
                GIT_AUTHOR_DATE: options.initialCommitDate,
                GIT_COMMITTER_DATE: options.initialCommitDate,
              }
            : {}),
        },
      },
    )
    const sha = git("rev-parse", "HEAD")
    const remote = join(directory, "remote.git")
    // A pack transfer, not a per-object copy, so background gc cannot race it.
    git("clone", "--bare", "--no-local", directory, remote)
    const workspaceUrl = github
      ? "https://github.com/fixture/hydration-contract.git"
      : remote
    if (github) {
      const gitConfig = join(directory, "fixture-git-config")
      git(
        "config",
        "--file",
        gitConfig,
        `url.${remote}.insteadOf`,
        workspaceUrl,
      )
      process.env.GIT_CONFIG_GLOBAL = gitConfig
      process.env.GITHUB_APP_ID = "12345"
      process.env.GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey
    }
    for (const file of expected)
      writeFileSync(join(directory, file.path), "Uncommitted replacement\n")
    await getSystemDb()
      .insert(organizations)
      .values({ ...org, createdAt: new Date() })
    if (github) {
      await withOrgDbContext(org.id, (db) =>
        db.insert(connections).values({
          id: connectionId,
          orgId: org.id,
          type: "github",
          config: {
            installationId: 123456789,
            ingestAllRepositories: false,
            includeFutureRepos: false,
          },
        }),
      )
    }
    await withOrgDbContext(org.id, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId: org.id,
        slug: "knowledge",
        displayName: org.name,
        workspaceRepositoryUrl: workspaceUrl,
        githubConnectionId: github ? connectionId : null,
        desiredSha: missingTip ? null : sha,
        desiredGeneration: 1,
        desiredDefaultBranch: "main",
        indexedSha: sha,
        writeStatus: writeStatus ?? "unknown",
        rootPath: options.rootPath ?? "",
      }),
    )
    const resolveRevision = async (refresh = false) => {
      const resolved = await withOrgIdContext(org, () =>
        resolveWorkspaceReadRevision({
          refresh,
          orgId: org.id,
          workspaceId,
          env: parseEnv(process.env),
        }),
      )
      if (!resolved) throw new Error("Fixture revision could not be captured")
      return resolved.revision
    }
    const revision = await resolveRevision()
    const handle = await runner.runWorkflow(workspaceHydrate.spec, {
      orgId: org.id,
      workspaceId,
      revision,
    })
    // A trace2 event without a parent session is any Git process that Git
    // itself did not start. A runner's Git wrapper or a detached helper adds
    // such events. The shim records only the commands that this process
    // starts, which are the commands the backend owns.
    const gitSpawns = join(gitShim, "spawns.log")
    if (options.traceGitCommands) {
      const shim = join(gitShim, "bin")
      mkdirSync(shim)
      const realGit = execFileSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).trim()
      writeFileSync(
        join(shim, "git"),
        [
          "#!/bin/sh",
          `if [ "$PPID" = "${process.pid}" ]; then printf '%s\\n' "$*" >> '${gitSpawns}'; fi`,
          `exec '${realGit}' "$@"`,
          "",
        ].join("\n"),
      )
      chmodSync(join(shim, "git"), 0o755)
      process.env.PATH = `${shim}:${process.env.PATH}`
      process.env.GIT_TRACE2_EVENT = gitTrace
    } else delete process.env.GIT_TRACE2_EVENT
    return {
      resolveRevision,
      revision,
      databaseUrl,
      directory,
      id,
      org,
      workspaceId,
      connectionId,
      git,
      tokenRequests,
      appPermissionRequests,
      semanticRequests,
      /** Add GitHub API handlers a single test needs with `server.use`. */
      server,
      backend,
      runner,
      worker,
      expected,
      sha,
      remote,
      workspaceUrl,
      handle,
      gitTrace,
      /** The Git commands that this process started, one argument line each. */
      gitCommands: () =>
        existsSync(gitSpawns)
          ? readFileSync(gitSpawns, "utf8").trim().split("\n")
          : [],
      count,
      cleanup,
      onWriteProbe: (callback: () => Promise<void>) => {
        beforeWriteProbe = callback
      },
      onWriteCredentialRequest: (callback: () => Promise<void>) => {
        beforeWriteCredential = callback
      },
      /** GitHub answers 422 when the repository is gone or not accessible. */
      failTokens: (status = 400) => {
        invalidateGithubAppCacheForConnection(connectionId)
        failGithubTokens = status
      },
      /**
       * Cache a Workspace format for the fixture binding, as hydrate does
       * after it reads `.ctxpipe/workspace.yaml` (ADR-053).
       */
      cacheFormat: (format: number) =>
        withOrgDbContext(org.id, (db) =>
          db
            .update(workspaces)
            .set({ activeRevision: revision, formatVersion: format })
            .where(eq(workspaces.id, workspaceId)),
        ),
      repairWriteAccess: () => {
        githubWriteView = "writable"
      },
      loseWriteAccess: () => {
        githubWriteView = "missing"
      },
      repairEmbeddings: () => {
        failEmbeddings = false
      },
      publish: async () => {
        await worker.start()
        expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: true,
          units: count,
          skipped: 0,
        })
        const run = await backend.getWorkflowRun({
          workflowRunId: handle.workflowRun.id,
        })
        expect(run?.status).toBe("completed")
        await withOrgIdContext(org, async () => {
          const active = await getWorkspaceProjection(workspaceId)
          if (active.kind !== "active")
            throw new Error("Expected active revision")
          await persistWorkspaceIndexResult({
            revision: active.revision,
            result: { kind: "ready" },
          })
        })
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export type NativeHydrationFixture = Awaited<
  ReturnType<typeof createNativeHydrationFixture>
>
export async function withNativeHydrationFixture(
  options: NativeHydrationOptions,
  run: (fixture: NativeHydrationFixture) => Promise<void>,
) {
  const fixture = await createNativeHydrationFixture(options)
  try {
    await run(fixture)
  } finally {
    await fixture.cleanup()
  }
}
