import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  modelMessagesToUIMessages,
  RUN_CANCEL_REASON,
  type StreamChunk,
  uiMessagesToWire,
} from "@tanstack/ai"
import { reconstructChat } from "@tanstack/ai-persistence"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { registerMcpTools } from "../../mcp/tools.js"
import {
  listSandboxInstances,
  persistOrgFirstWorkspace,
} from "../../models/workspaces.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import {
  streamTanstackWorkspaceChat,
  warmTanstackWorkspaceChat,
} from "./tanstack-workspace-chat.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"

it(
  "uses the prepared native worktree for two stock chat turns and persists their transcript",
  { timeout: 150_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const input = {
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
      }
      const prepared = await warmTanstackWorkspaceChat({
        ...input,
        prompt: "prepare",
      })
      if (!prepared.ok) throw new Error(prepared.error)
      await prepared.handle.fs.write("unsaved.txt", "kept through chat")
      expect(
        (
          await prepared.handle.process.exec(
            "printenv MODEL_PROVIDER_API_KEY AUTH_SECRET DATABASE_URL || true",
          )
        ).stdout,
      ).toBe("")
      const persistence = workspaceChatPersistence()
      for (const prompt of ["First question", "Second question"]) {
        const chunks: StreamChunk[] = []
        const turn = {
          ...input,
          prompt,
          runId: `${f.conversationId}-${prompt}`,
          messages: [
            ...(await persistence.stores.messages.loadThread(f.conversationId)),
            { id: `user-${prompt}`, role: "user", content: prompt },
          ],
        }
        if (prompt === "First question") {
          const response = await f.request(
            `/conversations/${f.conversationId}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                messages: turn.messages,
                tools: [],
                context: [],
                threadId: f.conversationId,
                runId: turn.runId,
                forwardedProps: { workspaceId: f.workspaceId },
              }),
            },
          )
          expect(response.status).toBe(200)
          chunks.push(
            ...(parseSseDataLines(await response.text()) as StreamChunk[]),
          )
        } else
          for await (const chunk of streamTanstackWorkspaceChat(turn))
            chunks.push(chunk)
        expect(chunks.filter((chunk) => chunk.type === "RUN_ERROR")).toEqual([])
        expect(
          chunks.filter((chunk) => chunk.type === "RUN_STARTED"),
        ).toHaveLength(1)
        expect(
          chunks.filter((chunk) => chunk.type === "RUN_FINISHED"),
        ).toHaveLength(1)
        expect(
          chunks
            .filter((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")
            .map((chunk) => chunk.delta)
            .join(""),
        ).toBe("Native reply completed.")
        const rows = await withOrgDbContext(f.orgId, () =>
          listSandboxInstances({
            conversationId: f.conversationId,
            kind: "chat",
          }),
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]?.providerSandboxId).toBe(prepared.handle.id)
      }
      const transcript = await persistence.stores.messages.loadThread(
        f.conversationId,
      )
      expect(
        transcript
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual(["First question", "Second question"])
      expect(
        transcript.filter((message) => message.role === "assistant"),
      ).toHaveLength(2)
      expect(await prepared.handle.fs.read("unsaved.txt")).toBe(
        "kept through chat",
      )
      expect(f.modelRequests.length).toBeGreaterThanOrEqual(2)
      const reconstructed = await reconstructChat(
        persistence,
        new Request(
          `http://native.test/reconstruct?threadId=${f.conversationId}`,
        ),
        { authorize: (threadId) => threadId === f.conversationId },
      )
      expect(await reconstructed.json()).toEqual({
        messages: modelMessagesToUIMessages(transcript).map((message) => ({
          ...message,
          ...(message.createdAt
            ? { createdAt: message.createdAt.toISOString() }
            : {}),
        })),
        activeRun: null,
        interrupts: null,
      })
    })
  },
)

function parseSseDataLines(body: string): object[] {
  const events: object[] = []
  for (const block of body.split("\n\n")) {
    const line = block.split("\n").find((entry) => entry.startsWith("data: "))
    if (!line) continue
    try {
      events.push(JSON.parse(line.slice(6)) as object)
    } catch {}
  }
  return events
}

it(
  "rejects an overlapping stale send without replacing the accepted transcript",
  { timeout: 60_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const responses = await Promise.all(
        ["Concurrent A", "Concurrent B"].map(async (prompt) => {
          const response = await f.request(
            `/conversations/${f.conversationId}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                threadId: f.conversationId,
                runId: `${f.conversationId}-${prompt}`,
                messages: [{ id: prompt, role: "user", content: prompt }],
                tools: [],
                context: [],
                state: {},
                forwardedProps: { workspaceId: f.workspaceId },
              }),
            },
          )
          return parseSseDataLines(await response.text()) as StreamChunk[]
        }),
      )
      const accepted = responses.filter((chunks) =>
        chunks.some((chunk) => chunk.type === "RUN_FINISHED"),
      )
      expect(accepted).toHaveLength(1)
      const rejectedPrompt = responses[0]?.some(
        (chunk) => chunk.type === "RUN_ERROR",
      )
        ? "Concurrent A"
        : "Concurrent B"
      expect(
        f.modelRequests.some((request) =>
          JSON.stringify(request).includes(rejectedPrompt),
        ),
      ).toBe(false)
      expect(
        responses
          .flat()
          .filter((chunk) => chunk.type === "RUN_ERROR")
          .map((chunk) => chunk.message),
      ).toEqual([
        "Conversation changed during another send; reload before retrying",
      ])
      for (const chunks of responses)
        expect(
          chunks.filter(
            (chunk) =>
              chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR",
          ),
        ).toHaveLength(1)
      const transcript =
        await workspaceChatPersistence().stores.messages.loadThread(
          f.conversationId,
        )
      expect(
        transcript.filter((message) => message.role === "user"),
      ).toHaveLength(1)
      expect(
        transcript.filter((message) => message.role === "assistant"),
      ).toHaveLength(1)
      expect(
        await withOrgDbContext(f.orgId, () =>
          listSandboxInstances({ conversationId: f.conversationId }),
        ),
      ).toHaveLength(1)
      const lateStale = await f.request(`/conversations/${f.conversationId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: f.conversationId,
          runId: `late-stale-${f.conversationId}`,
          messages: [
            { id: "stale-user", role: "user", content: "Late stale send" },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { workspaceId: f.workspaceId },
        }),
      })
      expect(
        (parseSseDataLines(await lateStale.text()) as StreamChunk[])
          .filter((chunk) => chunk.type === "RUN_ERROR")
          .map((chunk) => chunk.message),
      ).toEqual([
        "Conversation changed during another send; reload before retrying",
      ])
      expect(
        await workspaceChatPersistence().stores.messages.loadThread(
          f.conversationId,
        ),
      ).toEqual(transcript)
      expect(
        f.modelRequests.some((request) =>
          JSON.stringify(request).includes("Late stale send"),
        ),
      ).toBe(false)
      const retried = await f.request(`/conversations/${f.conversationId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: f.conversationId,
          runId: `retry-${f.conversationId}`,
          messages: [
            ...uiMessagesToWire(modelMessagesToUIMessages(transcript)),
            {
              id: "retry-user",
              role: "user",
              content: "Retry after reloading",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { workspaceId: f.workspaceId },
        }),
      })
      expect(retried.status).toBe(200)
      const retriedChunks = parseSseDataLines(
        await retried.text(),
      ) as StreamChunk[]
      expect(
        retriedChunks.filter((chunk) => chunk.type === "RUN_ERROR"),
      ).toEqual([])
      expect(
        retriedChunks.filter((chunk) => chunk.type === "RUN_FINISHED"),
      ).toHaveLength(1)
      expect(
        (
          await workspaceChatPersistence().stores.messages.loadThread(
            f.conversationId,
          )
        ).filter((message) => message.role === "user"),
      ).toHaveLength(2)
    })
  },
)

it.each([false, true])(
  "replays native WebSocket offsets and reloads the transcript in a fresh process (active disconnect: %s)",
  { timeout: 90_000 },
  async (activeDisconnect) => {
    const { stdout, stderr } = await promisify(execFile)(
      "bun",
      [
        fileURLToPath(
          new URL(
            "../../test/native-chat-websocket-client.ts",
            import.meta.url,
          ),
        ),
        ...(activeDisconnect ? ["--active-disconnect"] : []),
      ],
      { timeout: 80_000 },
    )
    expect(stderr).not.toMatch(/hook failed|durability failure|AbortError/)
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
    expect(result).toEqual({
      ...(activeDisconnect
        ? {
            disconnectedBeforeTerminal: true,
            abortedTerminal: true,
            retryMadeOneModelCall: true,
          }
        : {}),
      replayMatches: true,
      oneTerminal: true,
      noReplayModelCall: true,
      freshTranscript: activeDisconnect
        ? [
            "First socket question",
            "Question after disconnect",
            "Native reply completed.",
          ]
        : ["First socket question", "Native reply completed."],
    })
  },
)

it(
  "releases native transcript ownership after cancellation",
  { timeout: 35_000 },
  async () => {
    let started!: () => void
    let release!: () => void
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const modelResponse = new Promise<void>((resolve) => {
      release = resolve
    })
    await withNativeChatFixture(
      async (f) => {
        const controller = new AbortController()
        const input = {
          conversationId: f.conversationId,
          orgId: f.orgId,
          orgSlug: f.orgSlug,
          workspaceId: f.workspaceId,
          desiredUrl: f.directory,
          desiredSha: f.sha,
          defaultBranch: "main",
          writeStatus: "read_only",
        }
        const stopped = (async () => {
          for await (const _chunk of streamTanstackWorkspaceChat({
            ...input,
            runId: `cancel-${f.conversationId}`,
            prompt: "Cancel this turn",
            abortSignal: controller.signal,
          })) {
            /* Drain native cancellation. */
          }
        })()
        try {
          await modelStarted
          controller.abort(RUN_CANCEL_REASON)
          release()
          await stopped
          expect(
            await workspaceChatPersistence().stores.runs?.get(
              `cancel-${f.conversationId}`,
            ),
          ).toMatchObject({ status: "aborted" })
          const chunks: StreamChunk[] = []
          for await (const chunk of streamTanstackWorkspaceChat({
            ...input,
            runId: `retry-${f.conversationId}`,
            prompt: "Continue after cancellation",
          }))
            chunks.push(chunk)
          expect(chunks.filter((chunk) => chunk.type === "RUN_ERROR")).toEqual(
            [],
          )
          expect(
            chunks.filter((chunk) => chunk.type === "RUN_FINISHED"),
          ).toHaveLength(1)
        } finally {
          controller.abort()
          release()
          await stopped
        }
      },
      async () => {
        started()
        await modelResponse
      },
    )
  },
)

it(
  "MCP compatibility chat uses the captured non-main workspace branch",
  { timeout: 45_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      await promisify(execFile)("git", ["branch", "-m", "trunk"], {
        cwd: f.directory,
      })
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredDefaultBranch: "trunk" })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      await withOrgDbContext(f.orgId, async (db) => {
        await db.insert(workspaces).values({
          id: `${f.workspaceId}_older`,
          orgId: f.orgId,
          slug: "older",
          displayName: "Older",
          workspaceRepositoryUrl: `${f.directory}/older`,
          createdAt: new Date("2000-01-01"),
        })
        await persistOrgFirstWorkspace({
          orgId: f.orgId,
          workspaceId: f.workspaceId,
          sourceRepositoryId: "repo_fixture",
        })
      })
      const server = new McpServer({
        name: "native-chat-fixture",
        version: "1",
      })
      const client = new Client({ name: "native-chat-client", version: "1" })
      registerMcpTools(server)
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair()
      try {
        await Promise.all([
          server.connect(serverTransport),
          client.connect(clientTransport),
        ])
        const tools = await client.listTools()
        expect(tools.tools.map((tool) => tool.name)).toEqual(["ctx_advisor"])
        const before = await (
          await f.request(`/conversations?workspaceId=${f.workspaceId}`)
        ).json()
        const progress: unknown[] = []
        const reply = await client.callTool(
          {
            name: "ctx_advisor",
            arguments: {
              prompt: "Read the workspace",
              currentProjectName: "Fixture app",
              conversationId: "ignored-client-id",
            },
          },
          undefined,
          { onprogress: (event) => progress.push(event) },
        )
        expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true)
        expect(reply.content).toEqual([
          { type: "text", text: "Native reply completed." },
        ])
        expect(progress.length).toBeGreaterThan(0)
        const second = await client.callTool({
          name: "ctx_advisor",
          arguments: {
            prompt: "A separate question",
            conversationId: "ignored-client-id",
          },
        })
        expect(second.isError, JSON.stringify(second.content)).not.toBe(true)
        const calls = f.modelRequests.filter((request) =>
          Array.isArray(request.tools),
        )
        expect(calls).toHaveLength(2)
        expect(JSON.stringify(calls[0]?.messages)).toContain(
          "Project: Fixture app",
        )
        expect(JSON.stringify(calls[1]?.messages)).not.toContain(
          "Read the workspace",
        )
        const after = await (
          await f.request(`/conversations?workspaceId=${f.workspaceId}`)
        ).json()
        expect(after.items.map((item: { id: string }) => item.id)).toEqual(
          before.items.map((item: { id: string }) => item.id),
        )
        for (const [slug, confirmName] of [
          ["context", "Context"],
          ["older", "Older"],
        ]) {
          const deleted = await f.request(`/workspaces/${slug}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmName }),
          })
          expect(deleted.status).toBe(204)
        }
        const missing = await client.callTool({
          name: "ctx_advisor",
          arguments: { prompt: "No workspace remains" },
        })
        expect(missing.isError).toBe(true)
        expect(JSON.stringify(missing.content)).toContain("Create a Workspace")
      } finally {
        await client.close()
        await server.close()
      }
    })
  },
)

it(
  "rejects a colliding run through HTTP without changing its owning conversation",
  { timeout: 45_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const runs = workspaceChatPersistence().stores.runs
      const runId = `owned-${f.conversationId}`
      const original = await runs.createOrResume({
        runId,
        threadId: f.conversationId,
        startedAt: Date.now(),
      })
      const response = await f.request(
        `/conversations/${f.conversationId}-other`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            forwardedProps: { workspaceId: f.workspaceId },
            threadId: `${f.conversationId}-other`,
            runId,
            tools: [],
            context: [],
            messages: [
              {
                id: "collision-question",
                role: "user",
                content: "A different conversation",
              },
            ],
          }),
        },
      )
      expect(response.status).toBe(200)
      const chunks = parseSseDataLines(await response.text()) as StreamChunk[]
      expect(chunks.filter((chunk) => chunk.type === "RUN_ERROR")).toHaveLength(
        1,
      )
      expect(await runs.get(runId)).toEqual(original)
      expect(f.modelRequests).toHaveLength(0)
    })
  },
)
