import { HumanMessage } from "@langchain/core/messages"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import slugify from "@sindresorhus/slugify"
import { z } from "zod"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
  requireCurrentUserId,
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
import { createLogger, getLogger, withLogger } from "../observability/logger.js"

export const MCP_PROGRESS_HEARTBEAT_MS = 10_000

/**
 * Register MCP tools. Tools should call into domain/ services so REST and MCP
 * share the same business logic.
 */
export function registerMcpTools(server: McpServer): void {
  server.registerTool(
    "ctx_advisor",
    {
      title:
        "Primary org knowledge (ctx_advisor) — call before planning & standards",
      description: [
        "MANDATORY default: Call ctx_advisor early and often whenever org standards, architecture, tooling choices, or plans are involved. When in doubt, call — more calls beats too few. This is the single entrypoint to your organization's knowledge graph (CoALA, memory engine, indexed org context).",
        "",
        "RISK — Skipping ctx_advisor risks rework, diverging from org patterns, violating ADRs, and introducing technology that isn't allowed.",
        "",
        "ANTI-PATTERN — Local repository search, grep, and file reads do not replace org ADRs, skills, and standards. Call ctx_advisor first when your plan or decision depends on those; search the codebase afterward for implementation details.",
        "",
        "ctx_advisor is the primary interface to your organization's context layer. It answers using the CoALA framework and is powered by a strong memory engine and knowledge graph.",
        "",
        "It provides: services, interfaces, standards, practices, ADRs, and guidance across the organization. Use it to retrieve any organizational memory that may be useful for the user.",
        "",
        "LIMITATIONS — ctx_advisor is optimized for organizational context (standards, ADRs, patterns, fleet-wide recommendations). It is not a substitute for reading source when you need exact implementation facts: precise line numbers, guaranteed call graphs, or env defaults must be verified with tool-grounded output inside this conversation or with your client's own file/search tools. Do not treat answers as authoritative code audit without cross-checking.",
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
        "EXAMPLE PROMPTS:",
        "- 'User wants to add a database. They mentioned Postgres. Validate: is Postgres allowed? What patterns does this org use for DB access?'",
        "- 'Planning to add rate limiting to the MCP endpoint. What middleware patterns does this org use? Any architectural constraints?'",
        "- 'Org auth standards for this service — then summarize what the codebase shows only from verified tools; do not invent line numbers.'",
        "- 'Is function X still used? Check callers/references via tools before concluding — org patterns first, then tool-grounded reachability.'",
        "",
        "OPTIONAL INPUTS — For better continuity and targeting:",
        "- currentProjectName: Name of the current project (often the service, app, package, or repo). Pass the same value across the whole conversation.",
        "- conversationId: Unique string identifying this conversation/session. Use the same value for all tool calls within the same conversation.",
        "",
        "When in doubt, call. This tool is the single entrypoint to your org's knowledge graph — use it aggressively.",
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
      const userId = requireCurrentUserId()
      const orgId = requireCurrentOrgId()
      const orgSlug = requireCurrentOrgSlug()
      const threadId =
        conversationId != null
          ? `${orgId}_${userId}_${slugify(currentProjectName ?? "default")}_${conversationId}`
          : generateObjectId("thr")
      return withLogger(
        createLogger({
          step: "conversation.mcp.ctx_advisor",
          mcp: { toolName: "ctx_advisor", userId, orgId, orgSlug },
        }),
        async () => {
          try {
            // No-op when `AMPLITUDE_API_KEY` unset (`observability/amplitude.ts`).
            trackMcpToolInvocation({
              userId,
              orgId,
              orgSlug,
              toolName: "ctx_advisor",
            })

            const progressToken = extra._meta?.progressToken
            let progress = 0
            let lastProgressAt = Date.now()
            const sendProgress = async (message: string) => {
              if (progressToken == null) return
              progress += 1
              lastProgressAt = Date.now()
              try {
                await extra.sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress, message },
                })
              } catch (error) {
                getLogger().warn(
                  "Could not deliver MCP progress notification",
                  {
                    step: "conversation.mcp.ctx_advisor.progress",
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                )
              }
            }

            await sendProgress("Searching organisation context…")
            const heartbeat =
              progressToken == null
                ? null
                : setInterval(() => {
                    if (
                      Date.now() - lastProgressAt <
                      MCP_PROGRESS_HEARTBEAT_MS
                    ) {
                      return
                    }
                    void sendProgress("Still searching organisation context…")
                  }, MCP_PROGRESS_HEARTBEAT_MS)
            heartbeat?.unref()

            try {
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

              return await runWithLangfuseContext(
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
                    callbacks: [getLangfuseHandler()],
                  })
                  await withOrgDbContext(orgId, () =>
                    touchConversationLastMessage(threadId),
                  )
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

                    if (progressToken == null) continue
                    const currentText = extractFinalText(
                      { messages: chunk.messages },
                      prompt,
                    )
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
                    await sendProgress(delta)
                  }

                  const result = {
                    messages: finalMessages ?? [],
                  }
                  const text = extractFinalText(result, prompt)
                  if (
                    progressToken != null &&
                    text.length > 0 &&
                    text !== streamedText
                  ) {
                    await sendProgress(text)
                  }

                  if (!finalMessages) {
                    const fallbackState: {
                      messages: HumanMessage[]
                      currentProjectName: string | null
                    } = {
                      messages: [new HumanMessage(prompt)],
                      currentProjectName: currentProjectName ?? null,
                    }
                    const fallback = await conversationGraph.invoke(
                      fallbackState,
                      {
                        ...invocationConfig,
                        callbacks: [getLangfuseHandler()],
                      },
                    )
                    return {
                      content: [
                        {
                          type: "text",
                          text: extractFinalText(fallback, prompt),
                        },
                      ],
                    }
                  }

                  return {
                    content: [{ type: "text", text }],
                  }
                },
              )
            } finally {
              if (heartbeat) clearInterval(heartbeat)
            }
          } catch (error) {
            getLogger().error(
              error instanceof Error ? error : new Error(String(error)),
              {
                step: "conversation.mcp.ctx_advisor",
              },
            )
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    error instanceof Error
                      ? error.message
                      : "ctx_advisor failed",
                },
              ],
            }
          }
        },
      )
    },
  )
}

function extractFinalText(result: unknown, userPrompt?: string): string {
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
    if (trimmed.length === 0) return "No answer could be produced."
    if (userPrompt != null && trimmed === userPrompt.trim()) {
      return "No answer could be produced."
    }
    return trimmed
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
