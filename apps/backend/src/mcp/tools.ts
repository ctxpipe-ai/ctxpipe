import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createError } from "evlog"
import { z } from "zod"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
  requireCurrentUserId,
} from "../auth/context.js"
import { parseEnv } from "../config/env.js"
import { advisorWorkspaceId } from "../domain/workspaces/chat-sandbox-policy.js"
import { collectTanstackWorkspaceChatText } from "../domain/workspaces/tanstack-workspace-chat.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../domain/workspaces/write-status.js"
import { generateObjectId } from "../lib/id.js"
import {
  discardUnstartedConversation,
  ensureConversation,
  touchConversationLastMessage,
} from "../models/conversations.js"
import { getRepoReadCloneToken } from "../models/github-installation.js"
import {
  getPersistedFirstWorkspaceId,
  getWorkspaceById,
  listWorkspaces,
} from "../models/workspaces.js"
import { trackMcpToolInvocation } from "../observability/amplitude.js"
import { runWithLangfuseContext } from "../observability/langfuse.js"

/**
 * Register MCP tools. Tools should call into domain/ services so REST and MCP
 * share the same business logic.
 */
export function registerMcpTools(server: McpServer): void {
  server.registerTool(
    "ctx_advisor",
    {
      title:
        "Deprecated Workspace chat shim (ctx_advisor) — first Workspace only",
      description: [
        "DEPRECATED. ctx_advisor is a compatibility shim for Workspace chat on the organisation's first Workspace. There is no workspace.id argument and no org-wide advisor. Zero Workspaces → fail; create a Workspace first.",
        "Each invocation starts a new hidden MCP conversation (no cross-call memory).",
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
      inputSchema: z.object({
        prompt: z.string().min(1),
        currentProjectName: z.string().optional(),
        conversationId: z.string().optional(),
      }),
    },
    async ({ prompt, currentProjectName, conversationId }, extra) => {
      const userId = requireCurrentUserId()
      // No-op when `AMPLITUDE_API_KEY` unset (`observability/amplitude.ts`).
      trackMcpToolInvocation({
        userId,
        orgId: requireCurrentOrgId(),
        orgSlug: requireCurrentOrgSlug(),
        toolName: "ctx_advisor",
      })
      const { items } = await listWorkspaces()
      const persistedFirst = await getPersistedFirstWorkspaceId()
      const workspaceId = advisorWorkspaceId(persistedFirst, items)
      if (!workspaceId) {
        throw createError({
          message: "Create a Workspace before using ctx_advisor",
          status: 400,
          why: "Deprecated advisor targets the first Workspace; the org has none",
        })
      }
      void conversationId
      const threadId = generateObjectId("conv")
      await ensureConversation({
        id: threadId,
        source: "mcp",
        workspaceId,
      })
      const workspace = await getWorkspaceById(workspaceId)
      const desiredSha = workspace?.desiredSha
      if (!workspace || !desiredSha) {
        await discardUnstartedConversation(threadId)
        throw createError({
          message: "First Workspace is not hydrated yet",
          status: 409,
          why: "ctx_advisor needs a stored desired SHA on the first Workspace",
        })
      }
      const env = parseEnv(process.env as Record<string, string | undefined>)
      const repoFullName = githubRepoFullNameFromWorkspaceUrl(
        workspace.workspaceRepositoryUrl,
      )
      const promptWithProject = currentProjectName
        ? `Project: ${currentProjectName}\n\n${prompt}`
        : prompt
      try {
        return await runWithLangfuseContext(
          { sessionId: threadId, tags: ["mcp"] },
          async () => {
            const progressToken = extra._meta?.progressToken
            let progress = 0
            const collected = await collectTanstackWorkspaceChatText({
              conversationId: threadId,
              prompt: promptWithProject,
              orgId: requireCurrentOrgId(),
              workspaceId,
              desiredUrl: workspace.workspaceRepositoryUrl,
              desiredSha,
              desiredGeneration: workspace.desiredGeneration,
              ref: desiredSha,
              writeStatus: workspace.writeStatus,
              cloneToken: repoFullName
                ? ((await getRepoReadCloneToken(requireCurrentOrgId(), env, {
                    githubConnectionId:
                      workspace.githubConnectionId ?? undefined,
                    repoFullName,
                  })) ?? null)
                : null,
              onDelta: progressToken
                ? async (delta) => {
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
                : undefined,
            })
            void touchConversationLastMessage(threadId)
            if (!collected.ok) {
              throw createError({
                message: collected.error,
                status: collected.status,
                why: "Workspace chat runtime refused the MCP turn",
              })
            }
            return {
              content: [{ type: "text" as const, text: collected.text }],
            }
          },
        )
      } catch (error) {
        await discardUnstartedConversation(threadId)
        throw error
      }
    },
  )
}
