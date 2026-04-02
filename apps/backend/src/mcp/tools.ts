import { HumanMessage } from "@langchain/core/messages"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import slugify from "@sindresorhus/slugify"
import { z } from "zod"
import { requireCurrentUserId } from "../auth/context.js"
import { conversationGraph } from "../graphs/index.js"
import { generateObjectId } from "../lib/id.js"
import {
  ensureConversation,
  touchConversationLastMessage,
} from "../models/conversations.js"
import { runWithLangfuseContext } from "../observability/langfuse.js"
import { langfusePipelineCallbacks } from "../observability/langfusePipelineMetrics.js"

/**
 * Register MCP tools. Tools should call into domain/ services so REST and MCP
 * share the same business logic.
 */
export function registerMcpTools(server: McpServer): void {
  server.registerTool(
    "ctx_advisor",
    {
      description: [
        "ctx_advisor is the primary interface to your organization's context layer. It answers using the CoALA framework and is powered by a strong memory engine and knowledge graph.",
        "",
        "It provides: services, interfaces, standards, practices, ADRs, and guidance across the organization. Use it to retrieve any organizational memory that may be useful for the user.",
        "",
        "MANDATORY — ALWAYS call ctx_advisor BEFORE:",
        "- Any technology or tooling decision (e.g. database engine, framework, library, auth provider)",
        "- Any architectural decision (service boundaries, API design, data model)",
        "- Picking an implementation approach or pattern",
        "- Presenting a plan to the user (validate the plan first)",
        "- Session start — call at the very beginning of any new task to load organizational context",
        "",
        "MANDATORY — NEVER:",
        "- Choose a database, framework, or library without calling first — even if the user explicitly requested one (e.g. Postgres). Include the user's preference in your prompt and ask ctx_advisor to validate it against org standards.",
        "- Make an architectural decision without calling",
        "- Assume org patterns — always validate",
        "",
        "PROACTIVE RETRIEVAL — Call to proactively retrieve org memory that might help the user, even when the user hasn't asked a specific question. Surface relevant ADRs, patterns, or past decisions that could inform the work.",
        "",
        "PLANNING CHECKPOINTS — Call ctx_advisor:",
        "- At the start of planning (establish context)",
        "- Mid-planning when evaluating options (get feedback on trade-offs)",
        "- Just before presenting the plan to the user (validate against org standards)",
        "",
        "PROMPT QUALITY — Include in your prompt:",
        "- The task and what you're deciding",
        "- User preferences or constraints (e.g. 'user asked for Postgres' — still call to validate)",
        "- Relevant context: repo, domain, files, or subsystems involved",
        "- Options you're considering, if any",
        "",
        "RISK — Skipping this tool risks: rework, diverging from org patterns, violating ADRs, and introducing tech that isn't allowed.",
        "",
        "EXAMPLE PROMPTS:",
        "- 'User wants to add a database. They mentioned Postgres. Validate: is Postgres allowed? What patterns does this org use for DB access?'",
        "- 'Planning to add rate limiting to the MCP endpoint. What middleware patterns does this org use? Any architectural constraints?'",
        "",
        "OPTIONAL INPUTS — For better continuity and targeting:",
        "- currentProjectName: Name of the current project (often the service, app, package, or repo). Pass the same value across the whole conversation.",
        "- conversationId: Unique string identifying this conversation/session. Use the same value for all tool calls within the same conversation.",
        "",
        "When in doubt, call. More calls is better than fewer. This tool is the single entrypoint to your org's knowledge graph — use it aggressively.",
      ].join("\n"),
      inputSchema: z.object({
        prompt: z.string().min(1),
        currentProjectName: z.string().optional(),
        conversationId: z.string().optional(),
      }),
    },
    async ({ prompt, currentProjectName, conversationId }, extra) => {
      const threadId =
        conversationId != null
          ? `${requireCurrentUserId()}_${slugify(currentProjectName ?? "default")}_${conversationId}`
          : generateObjectId("thr")
      await ensureConversation({ id: threadId, source: "mcp" })
      const invocationConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: "ctx_advisor",
          source: "mcp",
        },
      }
      return runWithLangfuseContext(
        { sessionId: threadId, tags: ["mcp"] },
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
            callbacks: langfusePipelineCallbacks({
              step: "conversation.mcp.ctx_advisor",
              dimensions: { threadId },
            }),
          })
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
            const fallbackState: {
              messages: HumanMessage[]
              currentProjectName: string | null
            } = {
              messages: [new HumanMessage(prompt)],
              currentProjectName: currentProjectName ?? null,
            }
            const fallback = await conversationGraph.invoke(fallbackState, {
              ...invocationConfig,
              callbacks: langfusePipelineCallbacks({
                step: "conversation.mcp.ctx_advisor",
                dimensions: { threadId },
              }),
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
