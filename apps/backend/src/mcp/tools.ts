import { HumanMessage } from "@langchain/core/messages"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  ensureConversation,
  touchConversationLastMessage,
} from "../models/conversations.js"
import { chatGraph } from "../graphs/index.js"
import { generateObjectId } from "../lib/id.js"

/**
 * Register MCP tools. Tools should call into domain/ services so REST and MCP
 * share the same business logic.
 */
export function registerMcpTools(server: McpServer): void {
  server.registerTool(
    "ctx_advisor",
    {
      description: [
        "Primary ctx interface for agent guidance across architecture, implementation, and research.",
        "Use this tool whenever you need to:",
        "- ask questions about organizational architecture, platform patterns, and conventions",
        "- iterate on implementation plans before and during coding",
        "- validate decisions and get feedback on trade-offs",
        "- research how similar work is usually done across this organization",
        "Input should be a natural-language prompt with relevant context and constraints.",
        "For best results, call this tool early during planning and again when major decisions change.",
      ].join("\n"),
      inputSchema: z.object({
        prompt: z.string().min(1),
      }),
    },
    async ({ prompt }, extra) => {
      const threadId = generateObjectId("thr")
      await ensureConversation({ id: threadId, source: "mcp" })
      const invocationConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: "ctx_advisor",
          source: "mcp",
        },
      }
      const stream = await chatGraph.stream(
        { messages: [new HumanMessage(prompt)] },
        { streamMode: "values", ...invocationConfig },
      )
      void touchConversationLastMessage(threadId)
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
        const fallback = await chatGraph.invoke(
          {
            messages: [new HumanMessage(prompt)],
          },
          invocationConfig,
        )
        return {
          content: [{ type: "text", text: extractFinalText(fallback) }],
        }
      }

      return {
        content: [{ type: "text", text }],
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
