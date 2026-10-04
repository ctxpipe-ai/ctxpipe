import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { StreamChunk } from "@tanstack/ai"
import { defineSandbox, type SandboxHandle } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
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
  CHAT_SANDBOX_RETENTION_MS,
  chatSessionBranchName,
} from "./chat-lifecycle.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"
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

/**
 * Real Postgres, Git remote, production sandbox setup and pre-turn update,
 * broker and routes. Turns run the production chain with OpenCode; only the
 * model is scripted. Elsewhere the agent's `git commit` runs directly in the
 * sandbox, as its bash tool would.
 */
async function openSession(
  f: NativeHydrationFixture,
  agent: { steps: AgentStep[] },
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
    commitPush: () => post("push"),
    createPr: (title: string) => post("pull-request", { title }),
    pullRequests,
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
  const agent: { steps: AgentStep[] } = { steps: [] }
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
          const done = messages
            .slice(lastUser + 1)
            .filter((m) => m.role === "tool").length
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
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
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
      expect(s.remoteLog()).toBe("Add note two\nChat changes\nAdd note one")
      // Nothing to publish answers with a typed reason, not a raw error.
      const nothing = await s.commitPush()
      expect({ status: nothing.status, body: await nothing.json() }).toEqual({
        status: 400,
        body: { error: "no_changes" },
      })
      // Without a live sandbox Create PR uses the branch on GitHub.
      await s.asUser(() => destroySandboxesForConversation(s.conversationId))
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
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remote("merge-base", "--is-ancestor", human, s.branch)).toBe("")
      expect(s.remote("show", `${s.branch}:three.md`)).toBe("# Add note three")
      // Even when the agent fetched that commit itself (the tracking ref
      // matches GitHub), only the tip ctx| pushed may be replaced.
      const again = await s.humanCommit(s.branch, "again.md", "# Again\n")
      expect(
        (
          await handle.process.exec(
            `git fetch -q origin +refs/heads/${s.branch}:refs/remotes/origin/${s.branch}`,
          )
        ).exitCode,
      ).toBe(0)
      await s.agentCommit(handle, "four.md", "Add note four")
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remote("merge-base", "--is-ancestor", again, s.branch)).toBe("")
      expect(s.remote("show", `${s.branch}:four.md`)).toBe("# Add note four")
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
        ).toEqual({ status: "unchanged" })
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
  "moves to a fresh session branch from the current default once the PR is merged",
  { timeout: 180_000 },
  async () => {
    const pull = {
      number: 41,
      head: { ref: "" },
      state: "open",
      html_url: "https://github.com/fixture/hydration-contract/pull/41",
    }
    await withSession({ githubPullRequest: pull }, async (_f, s) => {
      pull.head.ref = s.branch
      let handle = await s.warm()
      await s.agentCommit(handle, "one.md", "Add note one")
      expect((await s.createPr("Add note one")).status).toBe(200)
      // Merged as a squash: the default gains the content, not the commits.
      pull.state = "closed"
      await s.advanceDefault("one.md", "# Add note one\n")
      handle = await s.warm()
      const next = chatSessionBranchName(s.conversationId, 2)
      expect(
        (await handle.process.exec("git branch --show-current")).stdout,
      ).toBe(`${next}\n`)
      expect(await s.conversation()).toMatchObject({
        lastBranch: next,
        lastChatPrNumber: null,
      })
      await s.agentCommit(handle, "two.md", "Add note two")
      expect((await s.commitPush()).status).toBe(200)
      expect(s.remoteLog(next)).toBe("Add note two")
    })
  },
)

it(
  "pushes committed work, never uncommitted files, before the sweep deletes a 30-day-old Docker sandbox",
  { timeout: 180_000 },
  async () => {
    await withSession({}, async (f, s) => {
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
        lifecycle: {
          reuse: "thread",
          snapshot: "none",
          destroyOnComplete: false,
        },
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
      try {
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
git checkout -q -b ${s.branch}
printf '# Committed\\n' > committed.md && git add committed.md
git -c user.name=Agent -c user.email=agent@example.test commit -q -m "Agent commit"
printf '# Draft\\n' > draft.md`,
        )
        expect(prepared).toMatchObject({ exitCode: 0 })
        const row = await getSandboxInstance(definition.key(ctx), f.org.id)
        if (!row) throw new Error("Sandbox row missing")
        // Stopped long ago: the deletion starts it once to push.
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaceSandboxInstances)
            .set({ state: "stopped" })
            .where(eq(workspaceSandboxInstances.id, row.id)),
        )
        const expired = new Date(
          row.lastHeartbeatAt.getTime() + CHAT_SANDBOX_RETENTION_MS + 60_000,
        )
        expect(
          await withTestLogger(() =>
            sweepConversationSandboxes(f.org.id, expired),
          ),
        ).toMatchObject({ deleted: 1 })
        expect(s.remoteLog()).toBe("Agent commit")
        expect(s.remote("show", `${s.branch}:committed.md`)).toBe("# Committed")
        expect(() => s.remote("show", `${s.branch}:draft.md`)).toThrow()
      } finally {
        await definition.destroy(ctx).catch(() => undefined)
      }
    })
  },
)
