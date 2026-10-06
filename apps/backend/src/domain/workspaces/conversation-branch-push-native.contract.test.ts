import { spawn } from "node:child_process"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { StreamChunk } from "@tanstack/ai"
import { defineSandbox, type SandboxHandle } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import Docker from "dockerode"
import { eq } from "drizzle-orm"
import { expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { getConversationSession } from "../../models/conversations.js"
import { getSandboxInstance } from "../../models/workspaces.js"
import { conversationRoutes } from "../../routes/v1/conversations.js"
import { workspaceChatOpenaiRoutes } from "../../routes/v1/workspace-chat-openai.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import {
  CHAT_SANDBOX_DELETE_AFTER_MS,
  chatSessionBranchName,
} from "./chat-lifecycle.js"
import { SANDBOX_READ_GIT, workspaceChatDockerImage } from "./chat-runtime.js"
import { pushConversationSession } from "./conversation-publish.js"
import {
  sweepConversationSandboxes,
  withConversationSandboxSlots,
} from "./conversation-sandbox-lifecycle.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import {
  streamTanstackWorkspaceChat,
  warmTanstackWorkspaceChat,
} from "./tanstack-workspace-chat.js"
import { workspaceChatOpenCodeHomeDir } from "./workspace-chat-opencode-contract.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"
import { destroySandboxesForConversation } from "./workspace-sandbox-cleanup.js"

type AgentStep =
  | { text: string }
  | { tool: string; args: Record<string, unknown> }

/** The scripted model: its next steps, and the tool results it received. */
type ScriptedAgent = { steps: AgentStep[]; toolResults: string[] }

/**
 * Real Postgres, Git remote, production sandbox setup and pre-turn update,
 * broker and routes. Turns run the production chain with OpenCode; only the
 * model is scripted. Elsewhere the agent's `git commit` runs directly in the
 * sandbox, as its bash tool would.
 */
async function openSession(
  f: NativeHydrationFixture,
  agent: ScriptedAgent,
  pullRequests: Array<Record<string, unknown>>,
) {
  const conversationId = `conv_${f.id}`
  const userId = `user_${f.id}`
  const branch = chatSessionBranchName(conversationId, 1)
  vi.stubEnv("SANDBOX_PROVIDER", "unsandboxed")
  await withOrgDbContext(f.org.id, (db) =>
    db.insert(conversations).values({
      id: conversationId,
      userId,
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      name: "Chat changes",
    }),
  )
  const asUser = <T>(fn: () => Promise<T>) =>
    withOrgIdContext(f.org, () =>
      withUserIdContext(userId, () => withTestLogger(fn)),
    )
  const desiredSha = async () =>
    (
      await withOrgDbContext(f.org.id, (db) =>
        db
          .select({ sha: workspaces.desiredSha })
          .from(workspaces)
          .where(eq(workspaces.id, f.workspaceId)),
      )
    )[0]?.sha ?? f.sha
  const conversation = () => getConversationSession(f.org.id, conversationId)
  const chatInput = async () => ({
    conversationId,
    orgId: f.org.id,
    orgSlug: f.org.slug,
    workspaceId: f.workspaceId,
    desiredUrl: f.workspaceUrl,
    desiredSha: await desiredSha(),
    desiredGeneration: f.revision.generation,
    githubConnectionId: f.connectionId,
    defaultBranch: "main",
    lastBranch: (await conversation())?.lastBranch ?? null,
    writeStatus: "writable",
    cloneToken: "fixture-native-clone",
  })
  /** Prepare, as a send or a Files read does: create or attach, then update. */
  const warm = async () => {
    const warmed = await asUser(async () =>
      warmTanstackWorkspaceChat({ ...(await chatInput()), prompt: "prepare" }),
    )
    if (!warmed.ok) throw new Error(warmed.error)
    return warmed.handle
  }
  /**
   * The agent commits in its sandbox, as its bash tool would, on the session
   * branch a turn checks out.
   */
  const agentCommit = async (
    handle: SandboxHandle,
    path: string,
    message: string,
  ) => {
    await handle.fs.write(path, `# ${message}\n`)
    const committed = await handle.process.exec(
      `{ [ "$(git branch --show-current)" != main ] || git checkout -q -b ${branch}; } && git add -A && git -c user.name=Agent -c user.email=agent@example.test commit -q -m '${message}'`,
    )
    expect(committed).toMatchObject({ exitCode: 0 })
  }
  /** A production turn: lock, persistence, sandbox, OpenCode, the tool bridge. */
  const turn = async (prompt: string, steps: AgentStep[]) => {
    agent.steps = steps
    const chunks: StreamChunk[] = []
    await asUser(async () => {
      for await (const chunk of streamTanstackWorkspaceChat({
        ...(await chatInput()),
        prompt,
        runId: `run_${f.id}_${Date.now()}`,
        messages: [
          ...(await workspaceChatPersistence().stores.messages.loadThread(
            conversationId,
          )),
          { id: `user_${Date.now()}`, role: "user", content: prompt },
        ],
      }))
        chunks.push(chunk)
    })
    expect(chunks.filter((chunk) => chunk.type === "RUN_ERROR")).toEqual([])
    return chunks
  }
  const remote = (...args: string[]) => f.git("--git-dir", f.remote, ...args)
  const remoteHas = (ref: string) =>
    remote("for-each-ref", "--format=%(refname)", `refs/heads/${ref}`) !== ""
  const remoteLog = (ref = branch) =>
    remoteHas(ref) ? remote("log", "--format=%s", `main..${ref}`) : ""
  /** A person commits on GitHub: on the default or the session branch. */
  const humanCommit = async (ref: string, path: string, body: string) => {
    const clone = await mkdtemp(join(tmpdir(), "ctxpipe-person-"))
    try {
      const git = (...args: string[]) => f.git("-C", clone, ...args)
      git("clone", "-q", "--branch", ref, f.remote, ".")
      await writeFile(join(clone, path), body)
      git("add", path)
      git(
        "-c",
        "user.name=Person",
        "-c",
        "user.email=person@example.test",
        "commit",
        "-q",
        "-m",
        `Edit ${path} on GitHub`,
      )
      git("push", "-q", "origin", `HEAD:refs/heads/${ref}`)
      return git("rev-parse", "HEAD")
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
  }
  /** The default branch moves and the Workspace follows it. */
  const advanceDefault = async (path: string, body: string) => {
    const sha = await humanCommit("main", path, body)
    await withOrgDbContext(f.org.id, (db) =>
      db
        .update(workspaces)
        .set({ desiredSha: sha })
        .where(eq(workspaces.id, f.workspaceId)),
    )
    return sha
  }
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set("env", parseEnv(process.env))
    c.set("user", { id: userId } as AppEnv["Variables"]["user"])
    c.set("session", { id: `sess_${f.id}` } as AppEnv["Variables"]["session"])
    c.set("orgSlug", f.org.slug)
    c.set("orgId", f.org.id)
    c.set("orgApiKey", null)
    await withOrgIdContext(f.org, next)
  })
  app.route("/conversations", conversationRoutes)
  app.route(
    `/${f.org.slug}/api/v1/workspace-chat/openai`,
    workspaceChatOpenaiRoutes,
  )
  const status = async () => {
    const response = await app.request(
      `/conversations/${conversationId}/files/status`,
    )
    expect(response.status).toBe(200)
    return (await response.json()) as { unpushed: boolean }
  }
  const post = (path: string, body?: unknown) =>
    app.request(`/conversations/${conversationId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
  return {
    conversationId,
    userId,
    branch,
    app,
    asUser,
    warm,
    agentCommit,
    turn,
    chatInput,
    conversation,
    remote,
    remoteHas,
    remoteLog,
    humanCommit,
    advanceDefault,
    status,
    commitPush: () => post("push"),
    createPr: (title: string) => post("pull-request", { title }),
    pullRequests,
    agent,
  }
}

type Session = Awaited<ReturnType<typeof openSession>>

/**
 * A fixture whose model is scripted per step, with the model proxy served
 * over HTTP for OpenCode.
 */
async function withSession(
  options: Parameters<typeof withNativeHydrationFixture>[0],
  run: (f: NativeHydrationFixture, s: Session) => Promise<void>,
) {
  const pullRequests: Array<Record<string, unknown>> = []
  const agent: ScriptedAgent = { steps: [], toolResults: [] }
  await withNativeHydrationFixture(
    {
      github: true,
      githubWriteView: "writable",
      writeStatus: "writable",
      onGithubPullRequest: (body) => {
        pullRequests.push(body as Record<string, unknown>)
      },
      chatAgent: {
        // One step per model call in the turn: tool calls, then the reply.
        next: ({ messages, tools }) => {
          const lastUser = messages.map((m) => m.role).lastIndexOf("user")
          const results = messages
            .slice(lastUser + 1)
            .filter((m) => m.role === "tool")
          const done = results.length
          agent.toolResults = results.map((m) =>
            String((m as { content?: unknown }).content),
          )
          const step = agent.steps[done] ?? { text: "Done." }
          if ("tool" in step && !tools.includes(step.tool))
            throw new Error(
              `Agent tool ${step.tool} is not offered: ${tools.join(", ")}`,
            )
          return step
        },
      },
      ...options,
    },
    async (f) => {
      const s = await openSession(f, agent, pullRequests)
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
          const response = await s.app.fetch(
            new Request(`http://127.0.0.1${req.url}`, {
              method: req.method,
              headers: req.headers as HeadersInit,
              body:
                req.method === "GET" || req.method === "HEAD"
                  ? undefined
                  : Buffer.concat(chunks),
            }),
          )
          res.writeHead(response.status, Object.fromEntries(response.headers))
          if (response.body)
            for await (const chunk of response.body) res.write(chunk)
          res.end()
        })().catch((error) => {
          res.writeHead(500)
          res.end(String(error))
        })
      })
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      )
      try {
        const address = server.address()
        if (!address || typeof address === "string")
          throw new Error("Model proxy port missing")
        vi.stubEnv("PORT", String(address.port))
        vi.stubEnv("MODEL_FAST_NAME", "openai/gpt-5.6-terra")
        await run(f, s)
      } finally {
        // The agent may still hold a streaming connection; never wait on it.
        server.close()
        server.closeAllConnections()
        await s.asUser(() => destroySandboxesForConversation(s.conversationId))
        await rm(workspaceChatOpenCodeHomeDir(s.conversationId), {
          recursive: true,
          force: true,
        })
        await withOrgDbContext(f.org.id, (db) =>
          db
            .delete(conversations)
            .where(eq(conversations.id, s.conversationId)),
        )
        vi.unstubAllEnvs()
      }
    },
  )
}

const bash = (command: string): AgentStep => ({
  tool: "bash",
  args: { command, description: "Run a command" },
})
const pushTool: AgentStep = {
  tool: "tanstack_push_conversation_branch",
  args: {},
}
const commitStep = (path: string, message: string) =>
  bash(
    `printf '# ${message}\\n' > ${path} && git add ${path} && git -c user.name=Agent -c user.email=agent@example.test commit -q -m '${message}'`,
  )

it(
  "lets the agent commit and push through its workspace tool, and pushes nothing when it does not",
  { timeout: 240_000 },
  async () => {
    await withSession({}, async (_f, s) => {
      await s.turn("Write two notes and publish them", [
        commitStep("one.md", "Add note one"),
        commitStep("two.md", "Add note two"),
        pushTool,
      ])
      expect(s.remoteLog()).toBe("Add note two\nAdd note one")
      expect(await s.conversation()).toMatchObject({
        lastBranch: s.branch,
        lastPushedSha: s.remote("rev-parse", s.branch),
      })
      const tip = s.remote("rev-parse", s.branch)
      // The agent commits without pushing: GitHub does not change.
      await s.turn("Write a third note", [
        commitStep("three.md", "Add note three"),
      ])
      expect(s.remote("rev-parse", s.branch)).toBe(tip)
    })
  },
)

it(
  "publishes with Commit+Push and Create PR, keeping the agent's commits",
  { timeout: 180_000 },
  async () => {
    await withSession({}, async (f, s) => {
      let handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      // The Files status and the push agree on what GitHub lacks.
      expect(await s.status()).toMatchObject({ unpushed: true })
      // A Files edit nobody committed.
      await handle.fs.write("files.md", "# Edited in Files\n")
      // A turn holds the conversation: both answer at once.
      let release!: () => void
      let held!: () => void
      const holding = new Promise<void>((resolve) => {
        held = resolve
      })
      const lock = postgresSandboxLocks(f.org.id).withLock(
        `chat-thread:${s.conversationId}`,
        () => {
          held()
          return new Promise<void>((resolve) => {
            release = resolve
          })
        },
      )
      await holding
      const started = Date.now()
      const busy = [await s.commitPush(), await s.createPr("Notes")]
      release()
      await lock
      for (const response of busy)
        expect({
          status: response.status,
          body: await response.json(),
        }).toEqual({ status: 409, body: { error: "turn_running" } })
      expect(Date.now() - started).toBeLessThan(5_000)
      // Commit+Push: the Files edit is committed, everything is pushed.
      const pushed = await s.commitPush()
      expect({ status: pushed.status, body: await pushed.json() }).toEqual({
        status: 200,
        body: {
          branch: s.branch,
          treeUrl: `https://github.com/fixture/hydration-contract/tree/${s.branch}`,
        },
      })
      expect(s.remoteLog()).toBe("Chat changes\nAdd note one")
      expect(await s.status()).toMatchObject({ unpushed: false })
      // The agent went back to the default branch: the next push keeps the
      // session's commits on GitHub.
      expect((await handle.process.exec("git checkout -q main")).exitCode).toBe(
        0,
      )
      await handle.fs.write("later.md", "# Later\n")
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remoteLog()).toBe("Chat changes\nChat changes\nAdd note one")
      // A failing commit answers a typed error; Git's own output stays in the log.
      await handle.fs.write(
        ".git/hooks/pre-commit",
        "#!/bin/sh\necho SECRET-HOOK-OUTPUT >&2\nexit 1\n",
      )
      await handle.process.exec("chmod 700 .git/hooks/pre-commit")
      await handle.fs.write("refused.md", "# Refused\n")
      const refused = await s.commitPush()
      const refusedBody = await refused.text()
      expect({ status: refused.status, body: JSON.parse(refusedBody) }).toEqual(
        {
          status: 502,
          body: { error: "push_failed" },
        },
      )
      expect(refusedBody).not.toContain("SECRET-HOOK-OUTPUT")
      await handle.process.exec("rm .git/hooks/pre-commit refused.md")
      // Create PR pushes the agent's unpushed commit and keeps every commit.
      await s.agentCommit(handle, "two.md", "Add note two")
      const created = await s.createPr("Write the notes")
      expect({
        status: created.status,
        body: await created.json(),
      }).toMatchObject({
        status: 200,
        body: { branch: s.branch, prNumber: 41 },
      })
      expect(s.pullRequests).toEqual([
        expect.objectContaining({
          head: s.branch,
          base: "main",
          title: "Write the notes",
        }),
      ])
      expect(s.remoteLog()).toBe(
        "Add note two\nChat changes\nChat changes\nAdd note one",
      )
      // Nothing to publish answers with a typed reason.
      const nothing = await s.commitPush()
      expect({ status: nothing.status, body: await nothing.json() }).toEqual({
        status: 400,
        body: { error: "no_changes" },
      })
      // Without a live sandbox Create PR uses the branch on GitHub.
      await s.asUser(() => destroySandboxesForConversation(s.conversationId))
      expect((await s.createPr("Write the notes")).status).toBe(200)
      handle = await s.warm()
      expect(await handle.fs.read("two.md")).toBe("# Add note two\n")
      expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
    })
  },
)

it(
  "keeps pushing after the default moves (option D) and never overwrites commits someone else pushed",
  { timeout: 180_000 },
  async () => {
    await withSession({}, async (f, s) => {
      let handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      expect((await s.commitPush()).status).toBe(200)
      // The default moves; the pre-turn update rebases the session onto it
      // and leaves its completed marker behind.
      const moved = await s.advanceDefault("default.md", "# Default moved\n")
      handle = await s.warm()
      await s.agentCommit(handle, "two.md", "Add note two")
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remote("merge-base", "--is-ancestor", moved, s.branch)).toBe("")
      expect(s.remoteLog()).toBe("Add note two\nAdd note one")
      // A person pushes to the session branch on GitHub.
      const human = await s.humanCommit(s.branch, "person.md", "# Person\n")
      await s.agentCommit(handle, "three.md", "Add note three")
      const refuse = async () => {
        const response = await s.commitPush()
        expect({
          status: response.status,
          body: await response.json(),
        }).toEqual({ status: 409, body: { error: "session_moved" } })
        expect(s.remote("rev-parse", s.branch)).toBe(human)
      }
      await refuse()
      // Fetching alone (the tracking ref matches GitHub) is not enough.
      const fetch = `git fetch -q origin +refs/heads/${s.branch}:refs/remotes/origin/${s.branch}`
      expect((await handle.process.exec(fetch)).exitCode).toBe(0)
      await refuse()
      // The agent rebases onto it, as the tool tells it to: both survive.
      expect(
        (
          await handle.process.exec(
            `git -c user.name=Agent -c user.email=agent@example.test rebase -q refs/remotes/origin/${s.branch}`,
          )
        ).exitCode,
      ).toBe(0)
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remote("merge-base", "--is-ancestor", human, s.branch)).toBe("")
      expect(s.remote("show", `${s.branch}:three.md`)).toBe("# Add note three")
      // A clean sandbox does no network work at all (GitHub unreachable).
      const away = `${f.remote}.away`
      await rename(f.remote, away)
      try {
        expect(
          await s.asUser(() =>
            pushConversationSession({
              handle: adaptTanstackHandle(handle),
              conversationId: s.conversationId,
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
            }),
          ),
        ).toEqual({ status: "unchanged", dirty: false })
      } finally {
        await rename(away, f.remote)
      }
    })
  },
)

it(
  "rebases a sandbox recreated after the default moved from the commit its branch builds on",
  { timeout: 180_000 },
  async () => {
    await withSession({}, async (_f, s) => {
      let handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      expect((await s.commitPush()).status).toBe(200)
      await s.asUser(() => destroySandboxesForConversation(s.conversationId))
      const moved = await s.advanceDefault("default.md", "# Default moved\n")
      handle = await s.warm()
      expect(
        (await handle.process.exec("git branch --show-current")).stdout,
      ).toBe(`${s.branch}\n`)
      expect(
        (
          await handle.process.exec(
            `git merge-base --is-ancestor ${moved} HEAD`,
          )
        ).exitCode,
      ).toBe(0)
      expect(await handle.fs.read("one.md")).toBe("# Add note one\n")
      await s.agentCommit(handle, "two.md", "Add note two")
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remote("merge-base", "--is-ancestor", moved, s.branch)).toBe("")
      expect(s.remoteLog()).toBe("Add note two\nAdd note one")
    })
  },
)

it(
  "pushes the session branch's commits when the sandbox sits on the default branch",
  { timeout: 180_000 },
  async () => {
    await withSession({}, async (_f, s) => {
      const handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      expect((await handle.process.exec("git checkout -q main")).exitCode).toBe(
        0,
      )
      expect(await s.status()).toMatchObject({ unpushed: true })
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remoteLog()).toBe("Add note one")
      expect(await s.status()).toMatchObject({ unpushed: false })
    })
  },
)

it(
  "refuses Commit+Push for a Workspace that is not on GitHub before it uses the sandbox",
  { timeout: 180_000 },
  async () => {
    await withSession({ github: false }, async (_f, s) => {
      // A clean sandbox: the refusal names the Workspace, not "no_changes".
      await s.warm()
      const refused = await s.commitPush()
      expect({ status: refused.status, body: await refused.json() }).toEqual({
        status: 400,
        body: { error: "not_github" },
      })
    })
  },
)

/**
 * Serve the fixture remote over HTTP, as GitHub does: a fetch without the
 * read credential is refused. Only the sandbox's `origin` uses it; ctx|'s own
 * Git calls keep the fixture's local remote.
 */
async function serveRemoteWithToken(
  f: NativeHydrationFixture,
  handle: SandboxHandle,
  token: string,
) {
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  const server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' })
      res.end()
      return
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: dirname(f.remote),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      },
    })
    req.pipe(cgi.stdin)
    const out: Buffer[] = []
    cgi.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    cgi.on("close", () => {
      const body = Buffer.concat(out)
      const split = body.indexOf("\r\n\r\n")
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of body.subarray(0, split).toString().split("\r\n")) {
        const at = line.indexOf(":")
        const name = line.slice(0, at).trim()
        const value = line.slice(at + 1).trim()
        if (name.toLowerCase() === "status") status = Number.parseInt(value)
        else headers[name] = value
      }
      res.writeHead(status, headers)
      res.end(body.subarray(split + 4))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Git server port missing")
  const origin = (url: string) =>
    handle.process.exec(`git remote set-url origin ${url}`)
  await origin(`http://127.0.0.1:${address.port}/${basename(f.remote)}`)
  return async () => {
    await origin(f.workspaceUrl)
    server.close()
    server.closeAllConnections()
  }
}

it(
  "tells the agent how to fetch a moved session branch with its read credential",
  { timeout: 240_000 },
  async () => {
    await withSession({}, async (f, s) => {
      await s.turn("Publish note one", [
        commitStep("one.md", "Add note one"),
        pushTool,
      ])
      const human = await s.humanCommit(s.branch, "person.md", "# Person\n")
      await s.turn("Publish note two", [
        commitStep("two.md", "Add note two"),
        pushTool,
      ])
      const refused = JSON.parse(s.agent.toolResults.at(-1) ?? "{}") as {
        reason?: string
        next?: string
      }
      expect(refused.reason).toBe("session_moved")
      const fetch = /`([^`]+)`/.exec(refused.next ?? "")?.[1] ?? ""
      expect(fetch).toContain(`${SANDBOX_READ_GIT} fetch`)
      const stop = await serveRemoteWithToken(
        f,
        await s.warm(),
        (await s.chatInput()).cloneToken,
      )
      try {
        // In the agent's shell, a fetch without the credential is refused;
        // the fetch the hint gives works. Then it rebases and pushes again.
        await s.turn("Follow the hint", [
          bash(
            `GIT_TERMINAL_PROMPT=0 git fetch -q origin "$(git branch --show-current)" && echo UNAUTHENTICATED_FETCHED || echo UNAUTHENTICATED_REFUSED`,
          ),
          bash(
            `GIT_TERMINAL_PROMPT=0 ${fetch} && git -c user.name=Agent -c user.email=agent@example.test rebase -q FETCH_HEAD`,
          ),
          pushTool,
        ])
        expect(s.agent.toolResults[0]).toContain("UNAUTHENTICATED_REFUSED")
      } finally {
        await stop()
      }
      expect(s.remote("merge-base", "--is-ancestor", human, s.branch)).toBe("")
      expect(s.remote("show", `${s.branch}:two.md`)).toBe("# Add note two")
    })
  },
)

const mergedPull = () => ({
  number: 41,
  head: { ref: "", sha: "" },
  state: "open",
  merged_at: null as string | null,
  html_url: "https://github.com/fixture/hydration-contract/pull/41",
})

it(
  "keeps the branch after a closed PR and continues on a fresh branch, with unpushed work, once it is merged",
  { timeout: 300_000 },
  async () => {
    const pull = mergedPull()
    await withSession({ githubPullRequest: pull }, async (_f, s) => {
      pull.head.ref = s.branch
      const handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      expect((await s.createPr("Add note one")).status).toBe(200)
      // Closed without a merge: the branch stays, Create PR opens a new PR.
      pull.state = "closed"
      await s.advanceDefault("other.md", "# Someone else\n")
      await s.turn("Write note two", [
        commitStep("two.md", "Add note two"),
        pushTool,
      ])
      expect(await s.conversation()).toMatchObject({ lastBranch: s.branch })
      expect(s.remoteLog()).toBe("Add note two\nAdd note one")
      expect((await s.createPr("Notes")).status).toBe(200)
      expect(s.pullRequests).toHaveLength(2)
      // Merged as a squash; the agent made one more commit and did not push.
      pull.state = "open"
      await s.agentCommit(handle, "three.md", "Add note three")
      // GitHub merged the head the session branch had on GitHub.
      pull.head.sha = s.remote("rev-parse", s.branch)
      pull.state = "closed"
      pull.merged_at = "2026-10-05T00:00:00Z"
      await s.advanceDefault("one.md", "# Add note one\n")
      // Never a second PR from a merged branch.
      const again = await s.createPr("Notes")
      expect({ status: again.status, body: await again.json() }).toEqual({
        status: 409,
        body: { error: "pr_merged" },
      })
      const next = chatSessionBranchName(s.conversationId, 2)
      await s.turn("Publish it", [pushTool])
      expect(await s.conversation()).toMatchObject({
        lastBranch: next,
        lastChatPrNumber: null,
      })
      expect(s.remoteLog(next)).toBe("Add note three")
    })
  },
)

it(
  "carries the session branch's unpushed work to the fresh branch when the sandbox sits on the default branch",
  { timeout: 300_000 },
  async () => {
    const pull = mergedPull()
    await withSession({ githubPullRequest: pull }, async (_f, s) => {
      pull.head.ref = s.branch
      const handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      expect((await s.createPr("Add note one")).status).toBe(200)
      await s.agentCommit(handle, "two.md", "Add note two")
      expect((await handle.process.exec("git checkout -q main")).exitCode).toBe(
        0,
      )
      // GitHub merged the head the session branch had on GitHub.
      pull.head.sha = s.remote("rev-parse", s.branch)
      pull.state = "closed"
      pull.merged_at = "2026-10-05T00:00:00Z"
      await s.advanceDefault("one.md", "# Add note one\n")
      const next = chatSessionBranchName(s.conversationId, 2)
      await s.turn("Publish it", [pushTool])
      expect(await s.conversation()).toMatchObject({ lastBranch: next })
      expect(s.remoteLog(next)).toBe("Add note two")
    })
  },
)

it(
  "starts the fresh branch at the new default when everything was pushed before the merge",
  { timeout: 300_000 },
  async () => {
    const pull = mergedPull()
    await withSession({ githubPullRequest: pull }, async (_f, s) => {
      pull.head.ref = s.branch
      const handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      expect((await s.createPr("Add note one")).status).toBe(200)
      // GitHub merged the head the session branch had on GitHub.
      pull.head.sha = s.remote("rev-parse", s.branch)
      pull.state = "closed"
      pull.merged_at = "2026-10-05T00:00:00Z"
      const merged = await s.advanceDefault("one.md", "# Add note one\n")
      const next = chatSessionBranchName(s.conversationId, 2)
      // The agent pushes: the fresh branch has nothing to publish yet.
      await s.turn("Anything new?", [pushTool])
      expect(
        (await handle.process.exec("git branch --show-current")).stdout,
      ).toBe(`${next}\n`)
      expect((await handle.process.exec("git rev-parse HEAD")).stdout).toBe(
        `${merged}\n`,
      )
      expect(await s.conversation()).toMatchObject({ lastBranch: next })
      expect(s.remoteLog(next)).toBe("")
    })
  },
)

it(
  "rotates once the agent rebased a conflicted merged branch onto the new default",
  { timeout: 300_000 },
  async () => {
    const pull = mergedPull()
    await withSession({ githubPullRequest: pull }, async (_f, s) => {
      pull.head.ref = s.branch
      const handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      expect((await s.createPr("Add note one")).status).toBe(200)
      pull.head.sha = s.remote("rev-parse", s.branch)
      // The agent edits the note and does not push; a reviewer edited it too
      // before the squash merge.
      await s.agentCommit(handle, "one.md", "Note one, edited")
      pull.state = "closed"
      pull.merged_at = "2026-10-05T00:00:00Z"
      const merged = await s.advanceDefault("one.md", "# Note one, reviewed\n")
      await s.warm()
      expect(await s.conversation()).toMatchObject({ lastBranch: s.branch })
      // The agent rebases onto the new default, as the conflict prompt asks.
      expect(
        (
          await handle.process.exec(
            `git -c user.name=Agent -c user.email=agent@example.test rebase -q -X theirs --onto ${merged} ${pull.head.sha}`,
          )
        ).exitCode,
      ).toBe(0)
      await s.warm()
      const next = chatSessionBranchName(s.conversationId, 2)
      expect(
        (await handle.process.exec("git branch --show-current")).stdout,
      ).toBe(`${next}\n`)
      expect(await s.conversation()).toMatchObject({
        lastBranch: next,
        lastChatPrNumber: null,
      })
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remoteLog(next)).toBe("Note one, edited")
    })
  },
)

it(
  "carries commits pushed after the merge to the fresh branch",
  { timeout: 300_000 },
  async () => {
    const pull = mergedPull()
    await withSession({ githubPullRequest: pull }, async (_f, s) => {
      pull.head.ref = s.branch
      const handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      expect((await s.createPr("Add note one")).status).toBe(200)
      pull.head.sha = s.remote("rev-parse", s.branch)
      pull.state = "closed"
      pull.merged_at = "2026-10-05T00:00:00Z"
      // A push after the merge, before the Workspace follows the default.
      await s.agentCommit(handle, "two.md", "Add note two")
      expect((await s.commitPush()).status).toBe(200)
      await s.advanceDefault("one.md", "# Add note one\n")
      await s.warm()
      const next = chatSessionBranchName(s.conversationId, 2)
      expect(await s.conversation()).toMatchObject({ lastBranch: next })
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remoteLog(next)).toBe("Add note two")
    })
  },
)

it(
  "keeps the sandbox on the conversation's recorded branch when a rotation loses a race",
  { timeout: 300_000 },
  async () => {
    const pull = mergedPull()
    let race: (() => Promise<void>) | undefined
    await withSession(
      {
        githubPullRequest: pull,
        onGithubPullRequestRead: async () => {
          const move = race
          race = undefined
          await move?.()
        },
      },
      async (f, s) => {
        pull.head.ref = s.branch
        const handle = await s.warm()
        await s.agentCommit(handle, "one.md", "Add note one")
        expect((await s.createPr("Add note one")).status).toBe(200)
        await s.agentCommit(handle, "two.md", "Add note two")
        pull.head.sha = s.remote("rev-parse", s.branch)
        pull.state = "closed"
        pull.merged_at = "2026-10-05T00:00:00Z"
        await s.advanceDefault("one.md", "# Add note one\n")
        // Another writer moves the conversation while the PR is read.
        const other = chatSessionBranchName(s.conversationId, 3)
        race = () =>
          withOrgDbContext(f.org.id, async (db) => {
            await db
              .update(conversations)
              .set({ lastBranch: other })
              .where(eq(conversations.id, s.conversationId))
          })
        await s.warm()
        expect(await s.conversation()).toMatchObject({ lastBranch: other })
        expect(
          (await handle.process.exec("git branch --show-current")).stdout,
        ).toBe(`${other}\n`)
        expect(await handle.fs.read("two.md")).toBe("# Add note two\n")
      },
    )
  },
)

/** A Docker sandbox as chat creates it, holding Git work the remote lacks. */
async function dockerSessionSandbox(
  f: NativeHydrationFixture,
  s: Session,
  script: string,
) {
  const image = workspaceChatDockerImage()
  const owner = {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    conversationId: s.conversationId,
    provider: "docker" as const,
    image,
    revision: { ...f.revision, access: "read" as const },
  }
  const definition = defineSandbox({
    id: "conversation-branch-push-delete-proof",
    provider: withConversationSandboxSlots(dockerSandbox({ image }), owner),
    lifecycle: { reuse: "thread", snapshot: "none", destroyOnComplete: false },
  })
  const ctx = {
    threadId: s.conversationId,
    runId: `run-${s.conversationId}`,
    store: postgresSandboxInstanceStore(owner),
    locks: postgresSandboxLocks(
      f.org.id,
      undefined,
      `workspace-sandboxes:${f.workspaceId}`,
    ),
    tenant: { userId: undefined, orgId: f.org.id },
  }
  const handle = await definition.ensure(ctx)
  // The container cannot reach the fixture remote; hand it the history.
  const bundle = join(f.directory, "main.bundle")
  f.git("--git-dir", f.remote, "bundle", "create", "-q", bundle, "main")
  await handle.fs.write(
    "/tmp/main.bundle.b64",
    (await readFile(bundle)).toString("base64"),
  )
  const prepared = await handle.process.exec(
    `set -e
base64 -d /tmp/main.bundle.b64 > /tmp/main.bundle
git init -q -b main . && git fetch -q /tmp/main.bundle main && git checkout -q -B main FETCH_HEAD
git update-ref refs/remotes/ctxpipe/base HEAD
${script}`,
  )
  expect(prepared).toMatchObject({ exitCode: 0 })
  const row = await getSandboxInstance(definition.key(ctx), f.org.id)
  if (!row?.providerSandboxId) throw new Error("Sandbox row missing")
  const id = row.providerSandboxId
  return {
    row,
    /**
     * Stopped long ago, as the idle sweep leaves it, or after a delete that
     * failed.
     */
    stop: async (state: "stopped" | "destroy_failed" = "stopped") => {
      await new Docker({ timeout: 30_000 }).getContainer(id).stop({ t: 1 })
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaceSandboxInstances)
          .set({ state })
          .where(eq(workspaceSandboxInstances.id, row.id)),
      )
    },
    destroy: () => definition.destroy(ctx).catch(() => undefined),
  }
}

it(
  "pushes committed work, never uncommitted files, before the sweep deletes a stopped Docker sandbox, after the default moved",
  { timeout: 180_000 },
  async () => {
    await withSession({ chatAgent: true }, async (f, s) => {
      const sandbox = await dockerSessionSandbox(
        f,
        s,
        `git checkout -q -b ${s.branch}
printf '# Committed\\n' > committed.md && git add committed.md
git -c user.name=Agent -c user.email=agent@example.test commit -q -m "Agent commit"
printf '# Draft\\n' > draft.md`,
      )
      try {
        await sandbox.stop()
        // The Workspace moved on while the sandbox was stopped.
        await s.advanceDefault("default.md", "# Default moved\n")
        const lastUse = sandbox.row.lastHeartbeatAt.getTime()
        // A stopped sandbox is due for deletion before its saved state expires.
        expect(
          await withTestLogger(() =>
            sweepConversationSandboxes(f.org.id, new Date(lastUse + 60_000)),
          ),
        ).toMatchObject({
          deleted: 0,
          nextSweepAt: new Date(lastUse + CHAT_SANDBOX_DELETE_AFTER_MS),
        })
        expect(
          await withTestLogger(() =>
            sweepConversationSandboxes(
              f.org.id,
              new Date(lastUse + CHAT_SANDBOX_DELETE_AFTER_MS),
            ),
          ),
        ).toMatchObject({ deleted: 1 })
        expect(s.remoteLog()).toBe("Agent commit")
        expect(s.remote("show", `${s.branch}:committed.md`)).toBe("# Committed")
        expect(() => s.remote("show", `${s.branch}:draft.md`)).toThrow()
      } finally {
        await sandbox.destroy()
      }
    })
  },
)

it(
  "moves a deleted sandbox's commits to a fresh branch when someone else pushed to the session branch",
  { timeout: 180_000 },
  async () => {
    await withSession({ chatAgent: true }, async (f, s) => {
      s.remote("update-ref", `refs/heads/${s.branch}`, f.sha)
      const foreign = await s.humanCommit(s.branch, "person.md", "# Person\n")
      // The session branch had a PR; Show PR must not open it for the new branch.
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(conversations)
          .set({ lastBranch: s.branch, lastChatPrNumber: 41 })
          .where(eq(conversations.id, s.conversationId)),
      )
      const sandbox = await dockerSessionSandbox(
        f,
        s,
        `git checkout -q -b ${s.branch}
printf '# Committed\\n' > committed.md && git add committed.md
git -c user.name=Agent -c user.email=agent@example.test commit -q -m "Agent commit"`,
      )
      try {
        await sandbox.stop()
        const lastUse = sandbox.row.lastHeartbeatAt.getTime()
        expect(
          await withTestLogger(() =>
            sweepConversationSandboxes(
              f.org.id,
              new Date(lastUse + CHAT_SANDBOX_DELETE_AFTER_MS),
            ),
          ),
        ).toMatchObject({ deleted: 1 })
        const next = chatSessionBranchName(s.conversationId, 2)
        expect(s.remote("rev-parse", s.branch)).toBe(foreign)
        expect(s.remoteLog(next)).toBe("Agent commit")
        expect(await s.conversation()).toMatchObject({
          lastBranch: next,
          lastChatPrNumber: null,
        })
      } finally {
        await sandbox.destroy()
      }
    })
  },
)

it(
  "pushes committed work before it retries a delete that failed",
  { timeout: 180_000 },
  async () => {
    await withSession({ chatAgent: true }, async (f, s) => {
      const sandbox = await dockerSessionSandbox(
        f,
        s,
        `git checkout -q -b ${s.branch}
printf '# Committed\\n' > committed.md && git add committed.md
git -c user.name=Agent -c user.email=agent@example.test commit -q -m "Agent commit"`,
      )
      try {
        await sandbox.stop("destroy_failed")
        const lastUse = sandbox.row.lastHeartbeatAt.getTime()
        expect(
          await withTestLogger(() =>
            sweepConversationSandboxes(f.org.id, new Date(lastUse + 60_000)),
          ),
        ).toMatchObject({ deleted: 1 })
        expect(s.remoteLog()).toBe("Agent commit")
      } finally {
        await sandbox.destroy()
      }
    })
  },
)

/** Sweep once at `after` past the sandbox's last use. */
const sweepAfter = (
  f: NativeHydrationFixture,
  sandbox: { row: { lastHeartbeatAt: Date } },
  after: number,
) =>
  withTestLogger(() =>
    sweepConversationSandboxes(
      f.org.id,
      new Date(sandbox.row.lastHeartbeatAt.getTime() + after),
    ),
  )

it(
  "aborts a rebase in progress and pushes the commits before the sweep deletes the sandbox",
  { timeout: 180_000 },
  async () => {
    await withSession({ chatAgent: true }, async (f, s) => {
      const sandbox = await dockerSessionSandbox(
        f,
        s,
        `git checkout -q -b ${s.branch}
printf '# Committed\\n' > committed.md && git add committed.md
git -c user.name=Agent -c user.email=agent@example.test commit -q -m "Agent commit"
GIT_SEQUENCE_EDITOR="sed -i -e s/^pick/edit/" git rebase -q -i HEAD~1
test -d .git/rebase-merge`,
      )
      try {
        await sandbox.stop()
        expect(
          await sweepAfter(f, sandbox, CHAT_SANDBOX_DELETE_AFTER_MS),
        ).toMatchObject({ deleted: 1 })
        expect(s.remoteLog()).toBe("Agent commit")
      } finally {
        await sandbox.destroy()
      }
    })
  },
)

it(
  "pushes the session branch's commits before deletion when HEAD is on the default branch",
  { timeout: 180_000 },
  async () => {
    await withSession({ chatAgent: true }, async (f, s) => {
      const sandbox = await dockerSessionSandbox(
        f,
        s,
        `git checkout -q -b ${s.branch}
printf '# Committed\\n' > committed.md && git add committed.md
git -c user.name=Agent -c user.email=agent@example.test commit -q -m "Agent commit"
git checkout -q main`,
      )
      try {
        await sandbox.stop()
        expect(
          await sweepAfter(f, sandbox, CHAT_SANDBOX_DELETE_AFTER_MS),
        ).toMatchObject({ deleted: 1 })
        expect(s.remoteLog()).toBe("Agent commit")
      } finally {
        await sandbox.destroy()
      }
    })
  },
)

it(
  "keeps a sandbox whose rescue push failed and pushes on the next sweep",
  { timeout: 240_000 },
  async () => {
    await withSession({ chatAgent: true }, async (f, s) => {
      // Someone pushed to the session branch and to the first rescue branch.
      const rescue = chatSessionBranchName(s.conversationId, 2)
      for (const ref of [s.branch, rescue]) {
        s.remote("update-ref", `refs/heads/${ref}`, f.sha)
        await s.humanCommit(ref, "person.md", "# Person\n")
      }
      const sandbox = await dockerSessionSandbox(
        f,
        s,
        `git checkout -q -b ${s.branch}
printf '# Committed\\n' > committed.md && git add committed.md
git -c user.name=Agent -c user.email=agent@example.test commit -q -m "Agent commit"`,
      )
      try {
        await sandbox.stop()
        expect(
          await sweepAfter(f, sandbox, CHAT_SANDBOX_DELETE_AFTER_MS),
        ).toMatchObject({ deleted: 0 })
        expect(await s.conversation()).toMatchObject({ lastBranch: rescue })
        expect(
          await sweepAfter(f, sandbox, CHAT_SANDBOX_DELETE_AFTER_MS + 60_000),
        ).toMatchObject({ deleted: 1 })
        const next = chatSessionBranchName(s.conversationId, 3)
        expect(s.remoteLog(next)).toBe("Agent commit")
        expect(await s.conversation()).toMatchObject({ lastBranch: next })
      } finally {
        await sandbox.destroy()
      }
    })
  },
)

it(
  "keeps a sandbox whose Git repository exists but cannot be read",
  { timeout: 180_000 },
  async () => {
    await withSession({ chatAgent: true }, async (f, s) => {
      // A crash can leave HEAD empty; the session branch still has the commit.
      const sandbox = await dockerSessionSandbox(
        f,
        s,
        `git checkout -q -b ${s.branch}
printf '# Committed\\n' > committed.md && git add committed.md
git -c user.name=Agent -c user.email=agent@example.test commit -q -m "Agent commit"
: > .git/HEAD`,
      )
      try {
        await sandbox.stop()
        expect(
          await sweepAfter(f, sandbox, CHAT_SANDBOX_DELETE_AFTER_MS),
        ).toMatchObject({ deleted: 0 })
      } finally {
        await sandbox.destroy()
      }
    })
  },
)

it(
  "deletes a sandbox that has no Git repository",
  { timeout: 180_000 },
  async () => {
    await withSession({ chatAgent: true }, async (f, s) => {
      const sandbox = await dockerSessionSandbox(f, s, "rm -rf .git")
      try {
        await sandbox.stop()
        expect(
          await sweepAfter(f, sandbox, CHAT_SANDBOX_DELETE_AFTER_MS),
        ).toMatchObject({ deleted: 1 })
      } finally {
        await sandbox.destroy()
      }
    })
  },
)
