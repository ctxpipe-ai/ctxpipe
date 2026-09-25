import type { BaseMessage, BaseMessageLike } from "@langchain/core/messages"
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages"
import { mergeConfigs } from "@langchain/core/runnables"
import { GraphRecursionError, getConfig } from "@langchain/langgraph"
import { log } from "../../../observability/logger.js"
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
- No duplicates: never call a tool again with the same or near-identical arguments. If a query returned nothing, rephrase it at most once, then report the gap.
- Step budget: aim to answer after 1–2 tool turns. After 3 tool turns without enough grounding, say what is unknown and answer from retrieval context plus any successful tool results.
- Recover from tool errors: if a tool returns an error (e.g. not_found, repository_not_found, search_client_error, structural_search_client_error) or HTTP 4xx-style fields, do not retry the same call. Fix the input at most once when the error says how (e.g. list_repositories for an unknown repositoryId); otherwise report the error and move on.

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

const humanSystemPrompt = `${baseInstructions}\n\n${humanResponseFormat}`
const mcpSystemPrompt = `${baseInstructions}\n\n${agentResponseFormat}`

const agentHuman = createAgent({
  model: getModel("medium", { temperature: 0.2, reasoning: false }),
  tools: [listRepositoriesTool, ...standardRepoExplorerTools],
  systemPrompt: humanSystemPrompt,
})

const agentMcp = createAgent({
  model: getModel("medium", { temperature: 0.2, reasoning: false }),
  tools: [listRepositoriesTool, ...standardRepoExplorerTools],
  systemPrompt: mcpSystemPrompt,
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

/**
 * The tool loop ran out of steps without a final answer. Answer once more,
 * without tools, from what the loop gathered instead of failing the turn.
 * Tool calls and results go in as plain text: Bedrock rejects tool blocks in a
 * request that binds no tools.
 */
async function answerAfterStepBudget(params: {
  systemPrompt: string
  retrievalContext: string | undefined
  history: BaseMessage[]
  generated: BaseMessageLike[]
  threadId: unknown
  source: string | undefined
}): Promise<Partial<ConversationGraphState>> {
  const argsByCallId = new Map<string, unknown>()
  for (const m of params.generated) {
    if (!AIMessage.isInstance(m)) continue
    for (const call of m.tool_calls ?? []) {
      if (call.id) argsByCallId.set(call.id, call.args)
    }
  }
  const results = params.generated
    .filter((m) => ToolMessage.isInstance(m))
    .map((m) => ({
      name: m.name,
      args: argsByCallId.get(m.tool_call_id),
      text: m.text,
    }))

  log.warn({
    step: "conversation.agent.recursion_limit",
    message: `Advisor tool loop hit the recursion limit (${AGENT_RECURSION_LIMIT}); answering without tools`,
    threadId: params.threadId,
    source: params.source,
    toolCalls: results.map(({ name, args, text }) => ({
      name,
      args,
      error: /^error\b/i.test(text) ? text.split("\n", 1)[0] : undefined,
    })),
  })

  const response = await getModel("medium", {
    temperature: 0.2,
    reasoning: false,
  }).invoke([
    new SystemMessage(params.systemPrompt),
    new SystemMessage(params.retrievalContext ?? "No retrieval context."),
    ...params.history.filter(
      (m) =>
        HumanMessage.isInstance(m) ||
        (AIMessage.isInstance(m) && !m.tool_calls?.length),
    ),
    new HumanMessage(
      [
        "The tool budget for this turn is spent. Do not call tools.",
        "Answer from the retrieval context and the tool results below, and say what you could not verify.",
        "",
        "Tool results:",
        results
          .map((r) => `${r.name} ${JSON.stringify(r.args)}\n${r.text}`)
          .join("\n\n") || "(none)",
      ].join("\n"),
    ),
  ])

  return {
    messages: [
      new AIMessage(
        `Partial answer: the advisor ran out of tool steps before it finished verifying.\n\n${response.text}`,
      ),
    ],
  }
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
  try {
    for await (const chunk of stream) {
      const fromChunk = extractAgentStateMessages(chunk)
      if (fromChunk) finalMessages = fromChunk
    }
  } catch (error) {
    if (!(error instanceof GraphRecursionError)) throw error
    return answerAfterStepBudget({
      systemPrompt: source === "mcp" ? mcpSystemPrompt : humanSystemPrompt,
      retrievalContext,
      history: messages,
      generated: (finalMessages ?? []).slice(inputMessages.length),
      threadId: config.configurable?.thread_id,
      source,
    })
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
