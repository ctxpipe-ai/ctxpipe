import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import {
  modelMessagesToUIMessages,
  RUN_CANCEL_REASON,
  type StreamChunk,
  uiMessagesToWire,
} from "@tanstack/ai"
import { reconstructChat } from "@tanstack/ai-persistence"
import { eq } from "drizzle-orm"
import { HttpResponse, http, passthrough } from "msw"
import { setupServer } from "msw/node"
import { expect, it, vi } from "vitest"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { conversationIdFromIdempotencyKey } from "../../lib/id.js"
import { sandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
import { listSandboxInstances } from "../../models/workspaces.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import {
  recordedRunGitToken,
  revokeIdleRunGitTokens,
} from "./run-git-tokens.js"
import { workspaceChatInstanceAccess } from "./sandbox-instance-store.js"
import {
  streamTanstackWorkspaceChat,
  warmTanstackWorkspaceChat,
  workspaceChatDockerOwnership,
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
      workspaceChatDockerOwnership.reset()
      workspaceChatInstanceAccess.reset()
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
        } else {
          const createsBeforeWarm = workspaceChatInstanceAccess.creates
          const hitsBeforeWarm = workspaceChatInstanceAccess.hits
          for await (const chunk of streamTanstackWorkspaceChat(turn))
            chunks.push(chunk)
          expect(workspaceChatInstanceAccess.creates).toBe(createsBeforeWarm)
          expect(
            workspaceChatInstanceAccess.hits - hitsBeforeWarm,
          ).toBeGreaterThanOrEqual(1)
        }
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
      expect(
        f.modelRequests.some((request) =>
          JSON.stringify(request).includes("https://docs.ctxpipe.ai/llms.txt"),
        ),
      ).toBe(true)
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
        ? { disconnectedBeforeTerminal: true, finishedAfterDisconnect: true }
        : {}),
      replayMatches: true,
      oneTerminal: true,
      noReplayModelCall: true,
      freshTranscript: ["First socket question", "Native reply completed."],
    })
  },
)

it(
  "streams the first turn of a new conversation on the WebSocket, setup first, and stores it",
  { timeout: 90_000 },
  async () => {
    const { stdout, stderr } = await promisify(execFile)(
      "bun",
      [
        fileURLToPath(
          new URL(
            "../../test/native-chat-websocket-client.ts",
            import.meta.url,
          ),
        ),
        "--new-conversation",
      ],
      { timeout: 80_000 },
    )
    expect(stderr).not.toMatch(/hook failed|durability failure|AbortError/)
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
    expect(result).toEqual({
      replayMatches: true,
      oneTerminal: true,
      noReplayModelCall: true,
      turnOrder: [
        "RUN_STARTED",
        "setup:starting",
        "setup:ready",
        "TEXT_MESSAGE_START",
        "RUN_FINISHED",
      ],
      freshTranscript: ["First socket question", "Native reply completed."],
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
  "masks credentials in streamed chunks and in the stored transcript",
  { timeout: 120_000 },
  async () => {
    // A made-up value in the shape of a GitHub token.
    const token = `ghp_${"Zx9Yw8Vu7T".repeat(4)}`
    await withNativeChatFixture(
      async (f) => {
        const chunks: StreamChunk[] = []
        for await (const chunk of streamTanstackWorkspaceChat({
          conversationId: f.conversationId,
          orgId: f.orgId,
          orgSlug: f.orgSlug,
          workspaceId: f.workspaceId,
          desiredUrl: f.directory,
          desiredSha: f.sha,
          defaultBranch: "main",
          writeStatus: "read_only",
          prompt: "Print the token",
          runId: `${f.conversationId}-mask`,
          messages: [
            { id: "mask-question", role: "user", content: "Print the token" },
          ],
        }))
          chunks.push(chunk)
        expect(chunks.filter((chunk) => chunk.type === "RUN_ERROR")).toEqual([])
        const streamed = JSON.stringify(chunks)
        expect(streamed).toContain("[masked]")
        expect(streamed).not.toContain(token)
        expect(
          chunks.some(
            (chunk) =>
              chunk.type === "TOOL_CALL_ARGS" ||
              chunk.type === "TOOL_CALL_START",
          ),
        ).toBe(true)
        const streamedText = chunks
          .flatMap((chunk) =>
            chunk.type === "TEXT_MESSAGE_CONTENT" ? [chunk.delta] : [],
          )
          .join("")
        // CTX-892: this check failed once in CI with no text at all. The
        // message lists the chunk types, so a new failure shows the order.
        expect(
          streamedText,
          `chunk types: ${chunks.map((chunk) => chunk.type).join(", ")}`,
        ).toContain("The token is [masked].")
        expect(streamedText).not.toContain(token)
        const stored = JSON.stringify(
          await workspaceChatPersistence().stores.messages.loadThread(
            f.conversationId,
          ),
        )
        expect(stored).toContain("[masked]")
        expect(stored).not.toContain(token)
      },
      undefined,
      {
        reply: `The token is ${token}.`,
        replyDeltaSize: 3,
        toolCall: (request) => {
          const messages = request.messages as Array<{ role: string }>
          return messages.some((message) => message.role === "tool")
            ? undefined
            : {
                name: "bash",
                arguments: JSON.stringify({
                  command: `echo ${token}`,
                  description: "Print the token",
                }),
              }
        },
      },
    )
  },
)

it(
  "masks credentials in the message of a run error",
  { timeout: 45_000 },
  async () => {
    const token = `ghp_${"Qw7Er6Ty5U".repeat(4)}`
    await withNativeChatFixture(async (f) => {
      const stream = streamTanstackWorkspaceChat({
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        writeStatus: "read_only",
        prompt: "Fail",
        resolveRuntime: async () => {
          throw new Error(
            `clone failed for https://x-access-token:${token}@github.com/o/r`,
          )
        },
      })
      const error = await (async () => {
        try {
          for await (const _chunk of stream) {
            /* drain */
          }
        } catch (caught) {
          return caught as Error
        }
        return undefined
      })()
      expect(error?.message).toBe(
        "clone failed for https://[masked]@github.com/o/r",
      )
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

it(
  "lists and scopes conversations and reuses first-message identity",
  { timeout: 60_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const missingWorkspace = await f.request("/conversations")
      expect(missingWorkspace.status).toBe(400)

      const scoped = await f.request(
        `/conversations/${f.conversationId}?workspaceId=${f.workspaceId}`,
      )
      expect(scoped.status).toBe(200)
      expect((await scoped.json()).conversation.workspaceId).toBe(f.workspaceId)

      const foreign = await f.request(
        `/conversations/${f.conversationId}?workspaceId=ws_other`,
      )
      expect(foreign.status).toBe(404)

      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(conversations)
          .set({ lastMessageAt: new Date(), source: "ui" })
          .where(eq(conversations.id, f.conversationId)),
      )
      const listed = await f.request(
        `/conversations?workspaceId=${f.workspaceId}`,
      )
      expect(listed.status).toBe(200)
      expect(
        (await listed.json()).items.map((item: { id: string }) => item.id),
      ).toEqual([f.conversationId])

      const body = JSON.stringify({
        threadId: "conv_start_1",
        runId: "run_start_1",
        messages: [{ id: "m1", role: "user", content: "hello" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { workspaceId: f.workspaceId, source: "ui" },
        idempotencyKey: "start-1",
      })
      const first = await f.request("/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      const second = await f.request("/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      const firstId = first.headers.get("x-conversation-id")
      expect(firstId).toBe(
        conversationIdFromIdempotencyKey(
          "start-1",
          `${f.userId}:${f.workspaceId}`,
        ),
      )
      expect(second.headers.get("x-conversation-id")).toBe(firstId)
      expect(firstId).not.toBe(f.conversationId)
      expect(
        conversationIdFromIdempotencyKey(
          "start-1",
          `${f.userId}:${f.workspaceId}_other`,
        ),
      ).not.toBe(firstId)
      await Promise.all([first.text(), second.text()])
    })
  },
)

it(
  "revokes the run's GitHub tokens after the turn releases its lock, when it finishes or is aborted, and leaves a failed revoke to the sweep",
  { timeout: 90_000 },
  async () => {
    const revoked: string[] = []
    let revokeStatus = 500
    const github = setupServer(
      http.delete(
        "https://api.github.com/installation/token",
        async ({ request }) => {
          revoked.push(request.headers.get("authorization") ?? "")
          return new HttpResponse(null, { status: revokeStatus })
        },
      ),
    )
    github.listen({ onUnhandledRequest: "bypass" })
    let fixture:
      | {
          orgId: string
          orgSlug: string
          conversationId: string
          workspaceId: string
          directory: string
          sha: string
        }
      | undefined
    let seed = ""
    let started: () => void = () => undefined
    let modelResponse: Promise<void> = Promise.resolve()
    try {
      await withNativeChatFixture(
        async (f) => {
          fixture = f
          const tokens = sandboxGitTokenStore(f.orgId, parseEnv(process.env))
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
          // Finished turn: GitHub refuses the revoke; the turn still succeeds.
          seed = "ghs_finished_turn"
          const chunks: StreamChunk[] = []
          for await (const chunk of streamTanstackWorkspaceChat({
            ...input,
            runId: `finish-${f.conversationId}`,
            prompt: "Finish this turn",
          }))
            chunks.push(chunk)
          expect(chunks.filter((chunk) => chunk.type === "RUN_ERROR")).toEqual(
            [],
          )
          expect(revoked).toEqual(["token ghs_finished_turn"])
          expect(
            (await tokens.list(`run:${f.conversationId}:`)).map(
              (row) => row.token,
            ),
          ).toEqual(["ghs_finished_turn"])
          // The sweep retries it once it is 2 minutes old.
          revokeStatus = 204
          vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3 * 60_000 })
          try {
            expect(await revokeIdleRunGitTokens({ orgId: f.orgId })).toBe(false)
          } finally {
            vi.useRealTimers()
          }
          expect(await tokens.list(`run:${f.conversationId}:`)).toEqual([])

          // Aborted turn.
          revoked.length = 0
          seed = "ghs_aborted_turn"
          let release!: () => void
          modelResponse = new Promise<void>((resolve) => {
            release = resolve
          })
          const modelStarted = new Promise<void>((resolve) => {
            started = resolve
          })
          const controller = new AbortController()
          const stopped = (async () => {
            for await (const _chunk of streamTanstackWorkspaceChat({
              ...input,
              runId: `abort-${f.conversationId}`,
              prompt: "Abort this turn",
              abortSignal: controller.signal,
            })) {
              /* Drain the cancelled run. */
            }
          })()
          await modelStarted
          controller.abort(RUN_CANCEL_REASON)
          release()
          await stopped
          expect(revoked).toEqual(["token ghs_aborted_turn"])
          expect(await tokens.list(`run:${f.conversationId}:`)).toEqual([])
        },
        async () => {
          // The turn's run token (a local run's clone token), recorded while
          // the turn holds the conversation lock.
          if (!fixture) throw new Error("Fixture missing")
          const { orgId, conversationId } = fixture
          const token = seed
          await recordedRunGitToken({
            orgId,
            conversationId,
            label: `clone:${seed === "ghs_finished_turn" ? "finish" : "abort"}-${conversationId}`,
            mint: async () => token,
          })
          started()
          await modelResponse
        },
      )
    } finally {
      github.close()
    }
  },
)

/**
 * A title model call that answers only when `release()` runs. `close()`
 * releases it too, so a failed test does not leave the call waiting. No wall
 * clock answers it: on a slow runner, a fallback timer answered the call
 * while the two turns of a test still ran.
 * Other model calls go to the fixture model.
 */
function slowTitleModel() {
  let requests = 0
  let answered = false
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = setupServer(
    http.post(/\/model\/v1\/chat\/completions$/, async ({ request }) => {
      const body = (await request.clone().json()) as {
        model?: string
        messages?: Array<{ content?: unknown }>
      }
      if (!JSON.stringify(body.messages ?? []).includes("word title"))
        return passthrough()
      requests += 1
      await released
      answered = true
      return HttpResponse.json({
        id: "completion-title",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Ledger answer" },
            finish_reason: "stop",
          },
        ],
      })
    }),
  )
  server.listen({ onUnhandledRequest: "bypass" })
  return {
    close: () => {
      release()
      server.close()
    },
    release,
    requests: () => requests,
    answered: () => answered,
  }
}

async function savedConversationName(orgId: string, conversationId: string) {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ name: conversations.name })
      .from(conversations)
      .where(eq(conversations.id, conversationId)),
  )
  return row?.name
}

it("sends the final event before the conversation title is ready, and still saves the title", async () => {
  const title = slowTitleModel()
  try {
    await withNativeChatFixture(async (f) => {
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(conversations)
          .set({ name: "New conversation" })
          .where(eq(conversations.id, f.conversationId)),
      )
      let answeredAtFinish: boolean | undefined
      for await (const chunk of streamTanstackWorkspaceChat({
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        runId: `title-${f.conversationId}`,
        prompt: "Where is the ledger?",
      })) {
        if (chunk.type === "RUN_ERROR")
          throw new Error(`The turn failed: ${JSON.stringify(chunk)}`)
        if (chunk.type === "RUN_FINISHED") {
          answeredAtFinish = title.answered()
          title.release()
        }
      }
      expect(title.requests()).toBe(1)
      expect(answeredAtFinish).toBe(false)
      // The title is saved after the final event.
      await vi.waitFor(
        async () =>
          expect(await savedConversationName(f.orgId, f.conversationId)).toBe(
            "Ledger answer",
          ),
        { timeout: 10_000, interval: 100 },
      )
    })
  } finally {
    title.close()
  }
})

it("makes no second title call while a turn of the same conversation still waits for its title", async () => {
  const title = slowTitleModel()
  try {
    await withNativeChatFixture(async (f) => {
      await withOrgDbContext(f.orgId, (db) =>
        db
          .update(conversations)
          .set({ name: "New conversation" })
          .where(eq(conversations.id, f.conversationId)),
      )
      for (const turn of ["first", "second"]) {
        for await (const chunk of streamTanstackWorkspaceChat({
          conversationId: f.conversationId,
          orgId: f.orgId,
          orgSlug: f.orgSlug,
          workspaceId: f.workspaceId,
          desiredUrl: f.directory,
          desiredSha: f.sha,
          defaultBranch: "main",
          writeStatus: "read_only",
          runId: `${turn}-${f.conversationId}`,
          prompt: "Where is the ledger?",
        })) {
          if (chunk.type === "RUN_ERROR")
            throw new Error(`The turn failed: ${JSON.stringify(chunk)}`)
        }
      }
      // Both turns ended while the first title call waits.
      expect(title.answered()).toBe(false)
      expect(title.requests()).toBe(1)
      title.release()
      await vi.waitFor(
        async () =>
          expect(await savedConversationName(f.orgId, f.conversationId)).toBe(
            "Ledger answer",
          ),
        { timeout: 10_000, interval: 100 },
      )
      expect(title.requests()).toBe(1)
    })
  } finally {
    title.close()
  }
})
