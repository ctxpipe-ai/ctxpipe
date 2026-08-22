import type { BaseMessageLike } from "@langchain/core/messages"
import { AIMessage, SystemMessage } from "@langchain/core/messages"
import { mergeConfigs } from "@langchain/core/runnables"
import { getConfig } from "@langchain/langgraph"
import { decideChatToolPermission } from "../../../domain/workspaces/chat-sandbox-policy.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import { listRepositoriesTool } from "../../../tools/listRepositories.js"
import { standardRepoExplorerTools } from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type { ConversationGraphState } from "../state.js"

/**
 * LangGraph step budget for the ReAct tool loop (model → tools → model → …).
 * Soft cap — prompt discipline should keep typical turns small; this is headroom.
 */
const AGENT_RECURSION_LIMIT = 20

const baseInstructions = `
You are the organizational context advisor. Your primary job is ORGANIZATIONAL CONTEXT: standards, ADRs, approved patterns, and what is common across the fleet — not speculative precision about the codebase.

GOAL: Surface what is RECOMMENDED and COMMON in this org — not merely what tools support.
- "What database?" → What do similar services use? What's in ADRs? What's common across the fleet?
- "What framework?" → Same reasoning: patterns, conventions, validated approaches.

REASONING:
1. Use claims (subject-predicate-object) to infer relationships (e.g. Service X WRITES_TO Postgres).
2. Aggregate: if many services use Postgres, that's the recommendation.
3. Prefer ADRs, instructions, and high-confidence claims over isolated code matches.

TOOL CALL DISCIPLINE (hard — follow on every turn):
- Fan out: when you need multiple pieces of evidence, issue parallel tool calls in one model turn (about 3–5 calls), not one serial call at a time.
- No duplicates: never call a tool again with the same or near-identical arguments. If a query returned nothing, change terms — do not repeat the same call.
- Step budget: aim to answer after 1–2 tool turns. After 3 tool turns without enough grounding, say what is unknown and answer from retrieval context plus any successful tool results.
- Recover from tool errors: if a tool returns an error (e.g. not_found, repository_not_found, search_client_error, structural_search_client_error) or HTTP 4xx-style fields, do not retry the exact same call — change inputs or move on.

EPISTEMIC RULES (hard — apply to every answer):
- Do NOT cite exact file line numbers (e.g. "line 344", "L481") unless that exact line reference appears verbatim in tool output from get_file, search, structural_search, or graph tools in this turn. Otherwise cite paths only, or say line numbers are not verified.
- Do NOT claim a symbol is unused, dead, legacy-only, or "never called" without calling graph_get_callers and/or find_symbol_references for that symbol in this turn when the question is about reachability or lifecycle. If tools are inconclusive or empty, say that explicitly instead of inferring.
- If retrieval context or tools show conflicting facts (e.g. different defaults in different files or docs vs code), report the conflict — do not flatten into one authoritative story.

When both org guidance and codebase facts apply, separate them:
- Org standard / recommendation (from ADRs, instructions, claims, patterns).
- What the codebase shows — only state precise implementation facts here when grounded in tool output from this turn.

PUSHBACK: When the user suggests something that contradicts org patterns:
- Acknowledge their preference.
- Explain what the graph shows (e.g. "All services use Postgres").
- Recommend the org standard with evidence.
- Offer to help with the recommended approach.

You have access to: (1) Pre-retrieved context (code search, claims, graph, fleet-wide patterns). (2) Tools for follow-up: list_repositories, glob_files (single folder: pattern "*", path "src/foo"; recursive: "**/package.json"), search, find_symbol_definitions, find_symbol_references, structural_search, graph_find_symbol, graph_get_callers, graph_get_callees, get_file.
Use retrieval context first. Use tools when you need verification beyond that context.

Tool use (conditional):
- Lexical discovery (unknown paths/symbols): search and find_symbol_definitions use Zoekt and are fast — use them to find paths and symbols when you lack anchors. get_file when you already have a path.
- Cross-file symbol relationships: graph_* uses SCIP's compiler/indexer-produced definitions and references. For reachability, lifecycle, "who calls", callers, callees, dead code, and references, treat graph_get_callers, graph_get_callees, graph_find_symbol, and find_symbol_references as primary — run them before asserting structure. When the symbol and repo are clear, prefer SCIP graph tools over broad Zoekt first.
- Syntax shapes within source: structural_search uses ast-grep. Use it for language-aware patterns such as a particular call, declaration, or nesting shape; it does not establish cross-file symbol identity or reachability.
`.trim()

/** Extra discipline for MCP (agent clients); UI chat uses baseInstructions only for epistemics. */
const mcpAnswerStructure = `
MCP OUTPUT STRUCTURE — When both org guidance and codebase detail matter, use two labeled sections:
- **Org standard** — recommendations, ADRs, patterns.
- **Codebase (tool-grounded)** — implementation facts only from tools in this turn; if you could not verify, say what is unknown.
`.trim()

const humanResponseFormat = `
Respond in natural language.
`.trim()

const agentResponseFormat = `
RESPONSE FORMAT (primary consumers are agents):
- Be concise. Use bullet points, structured facts, minimal prose.
- Lead with the answer or recommendation. Avoid preamble.
- Omit conversational filler ("Certainly!", "Let me explain", "In summary").
- Prefer clear facts over long paragraphs. For example: "Postgres. 12 services use it; ADR-003 recommends."

${mcpAnswerStructure}
`.trim()

function withWorkspaceChatPermission<
  T extends { name: string; invoke: (...args: never[]) => unknown },
>(tool: T): T {
  const original = tool.invoke.bind(tool)
  tool.invoke = ((input: unknown, config?: unknown) => {
    const writeStatus = String(
      (getConfig().configurable as { writeStatus?: string } | undefined)
        ?.writeStatus ?? "read_only",
    )
    const excerpt =
      typeof input === "string" ? input : JSON.stringify(input ?? "")
    if (
      decideChatToolPermission({
        toolName: tool.name,
        argsExcerpt: excerpt.slice(0, 400),
        writeStatus,
      }) === "deny" &&
      /commit|push|write|edit|apply_patch/i.test(tool.name)
    ) {
      return Promise.resolve({
        error: "permission_denied",
        reason: "workspace_chat_policy",
      })
    }
    return original(input as never, config as never)
  }) as T["invoke"]
  return tool
}

const conversationTools = [
  listRepositoriesTool,
  ...standardRepoExplorerTools,
].map((tool) => withWorkspaceChatPermission(tool))

const agentHuman = createAgent({
  model: getModel("medium", { temperature: 0.2, reasoning: false }),
  tools: conversationTools,
  systemPrompt: `${baseInstructions}\n\n${humanResponseFormat}`,
})

const agentMcp = createAgent({
  model: getModel("medium", { temperature: 0.2, reasoning: false }),
  tools: conversationTools,
  systemPrompt: `${baseInstructions}\n\n${agentResponseFormat}`,
})

function extractAgentStateMessages(
  chunk: unknown,
): BaseMessageLike[] | undefined {
  if (chunk === null || typeof chunk !== "object") return undefined

  if (Array.isArray(chunk)) {
    const mode = chunk.length === 3 ? chunk[1] : chunk[0]
    const data = chunk.length === 3 ? chunk[2] : chunk[1]
    if (
      mode === "values" &&
      data &&
      typeof data === "object" &&
      "messages" in data
    ) {
      const msgs = (data as { messages?: unknown }).messages
      if (Array.isArray(msgs)) return msgs as BaseMessageLike[]
    }
    return undefined
  }

  if (
    "messages" in chunk &&
    Array.isArray((chunk as { messages: unknown }).messages)
  ) {
    return (chunk as { messages: BaseMessageLike[] }).messages
  }
  return undefined
}

export async function agentNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { messages, retrievalContext } = state
  const config = getConfig()
  const source = config.configurable?.source as string | undefined
  const agent = source === "mcp" ? agentMcp : agentHuman

  const inputMessages: BaseMessageLike[] = [
    new SystemMessage(retrievalContext ?? "No retrieval context."),
    ...messages,
  ]

  // Merge parent graph config so LangGraph's StreamMessagesHandler stays on callbacks.
  // Do not add callbacks here — Langfuse handler is attached once at the graph boundary.
  const stream = await agent.stream(
    { messages: inputMessages },
    mergeConfigs(config, {
      streamMode: ["messages", "values"],
      recursionLimit: AGENT_RECURSION_LIMIT,
    }),
  )

  let finalMessages: BaseMessageLike[] | undefined
  for await (const chunk of stream) {
    const fromChunk = extractAgentStateMessages(chunk)
    if (fromChunk) finalMessages = fromChunk
  }

  if (!finalMessages) {
    return {
      messages: [new AIMessage("No answer could be produced.")],
    }
  }

  const generatedMessages = finalMessages.slice(inputMessages.length)
  if (generatedMessages.length === 0) {
    return {
      messages: [new AIMessage("No answer could be produced.")],
    }
  }

  return {
    messages: generatedMessages as ConversationGraphState["messages"],
  }
}
