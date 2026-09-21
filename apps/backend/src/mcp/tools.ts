import { HumanMessage } from "@langchain/core/messages"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import slugify from "@sindresorhus/slugify"
import { z } from "zod"
import {
  currentMcpActor,
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../auth/context.js"
import { withOrgDbContext } from "../db/client.js"
import { conversationGraph } from "../graphs/index.js"
import { generateObjectId } from "../lib/id.js"
import {
  ensureConversation,
  touchConversationLastMessage,
} from "../models/conversations.js"
import { trackMcpToolInvocation } from "../observability/amplitude.js"
import {
  getLangfuseHandler,
  runWithLangfuseContext,
} from "../observability/langfuse.js"
import { log } from "../observability/logger.js"

/**
 * Register MCP tools. Tools should call into domain/ services so REST and MCP
 * share the same business logic.
 */
export function registerMcpTools(server: McpServer): void {
  server.registerTool(
    "ctx_advisor",
    {
      title: "Org knowledge (ctx_advisor) — standards, architecture, and plans",
      description: [
        "Retrieves organizational context from the knowledge graph (CoALA, memory engine, indexed org context). Useful when a task depends on org standards, architecture, tooling choices, or existing plans.",
        "",
        "It provides services, interfaces, standards, practices, ADRs, and other organizational memory.",
        "",
        "Local repository search, grep, and file reads do not replace org ADRs, skills, and standards. Use ctx_advisor for those; search the codebase afterward for implementation details.",
        "",
        "LIMITATIONS — Optimized for organizational context. Precise line numbers, guaranteed call graphs, or env defaults should be verified with tool-grounded output in this conversation or with the client's own file/search tools.",
        "",
        "WHEN IT HELPS:",
        "- Technology or tooling decisions (database, framework, library, auth)",
        "- Architectural decisions (service boundaries, API design, data model)",
        "- Choosing an implementation approach",
        "- Checking a plan against org standards",
        "- Loading org context at the start of a task",
        "",
        "PROMPT QUALITY — Include the task and decision, user preferences or constraints, relevant repo/domain/files, and options under consideration.",
        "",
        "EXAMPLE PROMPTS:",
        "- 'User wants to add a database. They mentioned Postgres. What does this org use for persistence and data access?'",
        "- 'Planning to add rate limiting to the MCP endpoint. What middleware patterns does this org use? Any architectural constraints?'",
        "- 'Org auth standards for this service — then summarize what the codebase shows only from verified tools; do not invent line numbers.'",
        "- 'Is function X still used? Check callers/references via tools before concluding — org patterns first, then tool-grounded reachability.'",
        "",
        "OPTIONAL INPUTS — For better continuity and targeting:",
        "- currentProjectName: Name of the current project (often the service, app, package, or repo). Pass the same value across the whole conversation.",
        "- conversationId: Unique string identifying this conversation/session. Use the same value for all tool calls within the same conversation.",
      ].join("\n"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        prompt: z.string().min(1),
        currentProjectName: z.string().optional(),
        conversationId: z.string().optional(),
      }),
    },
    async ({ prompt, currentProjectName, conversationId }, extra) => {
      const actor = currentMcpActor()
      const orgId = requireCurrentOrgId()
      // No-op when `AMPLITUDE_API_KEY` unset (`observability/amplitude.ts`).
      trackMcpToolInvocation({
        userId:
          actor.type === "org-service" ? `org:${actor.orgId}` : actor.userId,
        orgId,
        orgSlug: requireCurrentOrgSlug(),
        toolName: "ctx_advisor",
      })
      const threadActorKey = actor.type === "org-service" ? "org" : actor.userId
      const threadId =
        conversationId != null
          ? `${orgId}_${threadActorKey}_${slugify(currentProjectName ?? "default")}_${conversationId}`
          : generateObjectId("thr")
      await withOrgDbContext(orgId, () =>
        ensureConversation({ id: threadId, source: "mcp" }),
      )
      const invocationConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: "ctx_advisor",
          source: "mcp",
        },
      }
      try {
        return await runWithLangfuseContext(
          {
            sessionId: threadId,
            tags:
              actor.type === "org-service" ? ["mcp", "mcp-org-key"] : ["mcp"],
          },
          async () => {
            const initialState: {
              messages: HumanMessage[]
              currentProjectName: string | null
            } = {
              messages: [new HumanMessage(prompt)],
              currentProjectName: currentProjectName ?? null,
            }
            const stream = await conversationGraph.stream(initialState, {
              streamMode: "values",
              ...invocationConfig,
              callbacks: [getLangfuseHandler()],
            })
            await withOrgDbContext(orgId, () =>
              touchConversationLastMessage(threadId),
            )
            const progressToken = extra._meta?.progressToken
            let progress = 0
            let streamedText = ""
            let finalMessages: unknown[] | undefined

            for await (const chunk of stream) {
              if (
                typeof chunk !== "object" ||
                chunk === null ||
                !("messages" in chunk) ||
                !Array.isArray(chunk.messages)
              ) {
                continue
              }
              finalMessages = chunk.messages

              if (!progressToken) continue
              const currentText = extractFinalText({ messages: chunk.messages })
              if (
                currentText.length === 0 ||
                currentText === "No answer could be produced."
              ) {
                continue
              }

              const delta = currentText.startsWith(streamedText)
                ? currentText.slice(streamedText.length)
                : currentText
              if (delta.length === 0) continue

              streamedText = currentText
              progress += 1
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress,
                  message: delta,
                },
              })
            }

            const result = {
              messages: finalMessages ?? [],
            }
            const text = extractFinalText(result)
            if (progressToken && text.length > 0 && text !== streamedText) {
              progress += 1
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress,
                  message: text,
                },
              })
            }

            if (!finalMessages) {
              const fallbackState: {
                messages: HumanMessage[]
                currentProjectName: string | null
              } = {
                messages: [new HumanMessage(prompt)],
                currentProjectName: currentProjectName ?? null,
              }
              const fallback = await conversationGraph.invoke(fallbackState, {
                ...invocationConfig,
                callbacks: [getLangfuseHandler()],
              })
              return {
                content: [{ type: "text", text: extractFinalText(fallback) }],
              }
            }

            return {
              content: [{ type: "text", text }],
            }
          },
        )
      } catch (error) {
        log.error({
          step: "conversation.mcp.ctx_advisor",
          message: error instanceof Error ? error.message : String(error),
          error,
        })
        throw error
      }
    },
  )
}

function extractFinalText(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("messages" in result) ||
    !Array.isArray(result.messages)
  ) {
    return "No answer could be produced."
  }

  const finalMessage = result.messages.at(-1)
  if (
    typeof finalMessage !== "object" ||
    finalMessage === null ||
    !("content" in finalMessage)
  ) {
    return "No answer could be produced."
  }

  const content = finalMessage.content
  if (typeof content === "string") {
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : "No answer could be produced."
  }

  if (Array.isArray(content)) {
    const textParts = content
      .flatMap((item) =>
        typeof item === "object" &&
        item !== null &&
        "text" in item &&
        typeof item.text === "string"
          ? [item.text.trim()]
          : [],
      )
      .filter((part) => part.length > 0)
    if (textParts.length > 0) return textParts.join("\n")
  }

  return "No answer could be produced."
}
