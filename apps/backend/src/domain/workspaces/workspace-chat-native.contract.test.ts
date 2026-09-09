import {
  chat,
  defineChatMiddleware,
  memoryStream,
  modelMessagesToUIMessages,
  type StreamChunk,
} from "@tanstack/ai"
import { opencodeText } from "@tanstack/ai-opencode"
import { reconstructChat } from "@tanstack/ai-persistence"
import {
  provideSandbox,
  provideSandboxDurability,
  SandboxCapability,
  SandboxDurabilityCapability,
} from "@tanstack/ai-sandbox"
import { expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import { listSandboxInstances } from "../../models/workspaces.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import {
  streamTanstackWorkspaceChat,
  warmTanstackWorkspaceChat,
} from "./tanstack-workspace-chat.js"
import { parseSseDataLines } from "./workspace-chat-agui.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"

it(
  "pins the native OpenCode durable-attach gap without rerunning a completed prompt",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      const prepared = await warmTanstackWorkspaceChat({
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      })
      if (!prepared.ok) throw new Error(prepared.error)
      const fixtureCapabilities = defineChatMiddleware({
        name: "native-opencode-attach-contract",
        provides: [SandboxCapability, SandboxDurabilityCapability],
        setup(ctx) {
          provideSandbox(ctx, prepared.handle)
          provideSandboxDurability(ctx, {
            runs: workspaceChatPersistence().stores.runs,
            adapter: memoryStream(
              new Request(`http://native.test?runId=${f.conversationId}`),
            ),
            journalDir: "/tmp/tanstack-runs",
            attach: true,
            detachOnDisconnect: true,
          })
        },
      })
      const chunks: StreamChunk[] = []
      for await (const chunk of chat({
        adapter: opencodeText("openai/gpt-5.6-terra"),
        threadId: f.conversationId,
        runId: f.conversationId,
        messages: [{ role: "user", content: "Do not execute again" }],
        middleware: [fixtureCapabilities],
      }))
        chunks.push(chunk)
      const errors = chunks.filter((chunk) => chunk.type === "RUN_ERROR")
      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toContain(
        "cannot ATTACH to an existing durable run",
      )
      expect(f.modelRequests).toEqual([])
    })
  },
)

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
