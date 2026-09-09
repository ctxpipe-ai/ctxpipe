import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  modelMessagesToUIMessages,
  RUN_CANCEL_REASON,
  type StreamChunk,
} from "@tanstack/ai"
import { reconstructChat } from "@tanstack/ai-persistence"
import { expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import { listSandboxInstances } from "../../models/workspaces.js"
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
        messages: modelMessagesToUIMessages(transcript),
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
      const retried = await f.request(`/conversations/${f.conversationId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: f.conversationId,
          runId: `retry-${f.conversationId}`,
          messages: [
            ...transcript,
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

it(
  "replays native WebSocket offsets and reloads the transcript in a fresh process",
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
      ],
      { timeout: 80_000 },
    )
    expect(stderr).not.toMatch(/hook failed|durability failure|AbortError/)
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
    expect(result).toEqual({
      replayMatches: true,
      oneTerminal: true,
      noReplayModelCall: true,
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
