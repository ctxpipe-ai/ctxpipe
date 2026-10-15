import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import { generateObjectId } from "../../lib/id.js"
import {
  ensureConversation,
  getConversation,
} from "../../models/conversations.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { judgeChatToolWithFastModel } from "./chat-sandbox-policy.js"
import { invokeCommitSubjectModel } from "./commit-subject.js"
import { nameConversationIfUnnamed } from "./conversation-title.js"
import { classifyUnkeyedKnowledgeCollision } from "./dest-workspace-first.js"
import { updateFolderList } from "./folder-list.js"
import { resolveSemanticConflicts } from "./semantic-merge.js"

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest owns this MSW lifecycle.
const server = useMswServer()
const orgId = generateObjectId("org")
const org = { id: orgId, slug: `host-model-${orgId}` }
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  await getSystemDb().insert(organizations).values({
    id: orgId,
    name: "Host model integration",
    slug: org.slug,
    createdAt: new Date(),
  })
})
afterEach(() => vi.unstubAllEnvs())
afterAll(async () => {
  await withOrgDbContext(orgId, (db) =>
    db.delete(conversations).where(eq(conversations.orgId, orgId)),
  )
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

it.each([
  "openrouter",
  "azure",
  "bedrock",
] as const)("sends each host caller through %s with its tier, prompt, and schema", async (provider) => {
  vi.stubEnv("MODEL_PROVIDER", provider)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://host-calls.test/v1")
  vi.stubEnv("MODEL_FAST_NAME", "fast")
  vi.stubEnv("MODEL_MEDIUM_NAME", "medium")
  vi.stubEnv("MODEL_HIGH_NAME", "high")
  vi.stubEnv("MODEL_BEDROCK_AWS_REGION", "us-east-1")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-access")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-secret")
  const expected = [
    {
      model: "anthropic/claude-haiku-4-5",
      prompt: "Write a subject",
      reply: "Update knowledge",
    },
    {
      model: "fast",
      prompt: "Where is the ledger?",
      reply: "Ledger location",
      temperature: 0.5,
    },
    { model: "fast", prompt: "echo hello", reply: "allow" },
    {
      model: "medium",
      prompt: "runbooks/",
      tool: "agents_md_folder_list",
      reply: { listBlock: "none" },
      property: "listBlock",
    },
    {
      model: "high",
      prompt: "a.md",
      tool: "workspace_semantic_merge",
      reply: { files: [{ path: "a.md", content: "merged" }] },
      property: "files",
    },
    {
      model: "fast",
      prompt: "knowledge/a.md",
      tool: "structured_output",
      reply: { decision: "merge" },
      property: "decision",
    },
  ]
  let count = 0
  server.use(
    http.post(
      provider === "bedrock"
        ? "https://bedrock-runtime.us-east-1.amazonaws.com/model/:model/converse"
        : "https://host-calls.test/v1/chat/completions",
      async ({ request, params }) => {
        const call = expected[count++]
        if (!call) throw new Error("Unexpected model request")
        const body = (await request.json()) as Record<string, unknown>
        expect(JSON.stringify(body.messages)).toContain(call.prompt)
        if (provider === "bedrock") {
          expect(params.model).toBe(call.model)
          if (call.temperature !== undefined)
            expect(body.inferenceConfig).toMatchObject({
              temperature: call.temperature,
            })
          if (call.tool)
            expect(body.toolConfig).toMatchObject({
              tools: [
                {
                  toolSpec: {
                    name: call.tool,
                    inputSchema: { json: { required: [call.property] } },
                  },
                },
              ],
              toolChoice: { tool: { name: call.tool } },
            })
          return HttpResponse.json({
            output: {
              message: {
                role: "assistant",
                content: call.tool
                  ? [
                      {
                        toolUse: {
                          toolUseId: "call",
                          name: call.tool,
                          input: call.reply,
                        },
                      },
                    ]
                  : [{ text: call.reply }],
              },
            },
            stopReason: call.tool ? "tool_use" : "end_turn",
            usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
            metrics: { latencyMs: 1 },
          })
        }
        expect(body).toMatchObject({ model: call.model, stream: false })
        if (call.temperature !== undefined)
          expect(body.temperature).toBe(call.temperature)
        if (call.tool)
          expect(body).toMatchObject({
            tools: [
              {
                function: {
                  name: call.tool,
                  parameters: { required: [call.property] },
                },
              },
            ],
            tool_choice: { type: "function", function: { name: call.tool } },
          })
        return HttpResponse.json({
          choices: [
            {
              message: {
                role: "assistant",
                ...(call.tool
                  ? {
                      tool_calls: [
                        {
                          id: "call",
                          type: "function",
                          function: {
                            name: call.tool,
                            arguments: JSON.stringify(call.reply),
                          },
                        },
                      ],
                    }
                  : { content: call.reply }),
              },
            },
          ],
        })
      },
    ),
  )
  await expect(invokeCommitSubjectModel("Write a subject")).resolves.toBe(
    "Update knowledge",
  )
  const id = generateObjectId("conv")
  await withOrgIdContext(org, () =>
    withUserIdContext("user_host_model_fixture", async () => {
      await ensureConversation({ id, source: "ui" })
      await expect(
        nameConversationIfUnnamed({
          conversationId: id,
          prompt: "Where is the ledger?",
        }),
      ).resolves.toBe("Ledger location")
      expect((await getConversation(id))?.name).toBe("Ledger location")
    }),
  )
  await expect(judgeChatToolWithFastModel("bash", "echo hello")).resolves.toBe(
    "allow",
  )
  await expect(
    withLogger(createLogger({}), () =>
      updateFolderList({
        agentsMd: "Read this first.\n",
        folders: { previous: [], current: ["runbooks/"] },
      }),
    ),
  ).resolves.toBe("Read this first.\n\n## Folders\n\n- `runbooks/`\n")
  await expect(
    resolveSemanticConflicts([
      { path: "a.md", base: "one", current: "two", incoming: "three" },
    ]),
  ).resolves.toEqual([{ path: "a.md", content: "merged" }])
  await expect(
    classifyUnkeyedKnowledgeCollision({
      existingPath: "knowledge/a.md",
      incomingPath: "knowledge/a.md",
      existingExcerpt: "one",
      incomingExcerpt: "two",
    }),
  ).resolves.toBe("merge")
  expect(count).toBe(6)
})
