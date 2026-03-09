import type { BaseMessageLike } from "@langchain/core/messages"
import { AIMessage, SystemMessage } from "@langchain/core/messages"
import { createAgent } from "langchain"
import { listRepositories } from "src/models/repositories.js"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../../auth/context.js"
import { getModel } from "../../../config/models.js"
import { toToon } from "../../../lib/agentToolRuntime.js"
import { getFileTool } from "../../../tools/getFile.js"
import { listFilesTool } from "../../../tools/listFiles.js"
import { listRepositoriesTool } from "../../../tools/listRepositories.js"
import { searchTool } from "../../../tools/search.js"
import { graph as retrievalGraph } from "../../retrievalGraph/graph.js"

const retrievalAugmentedInstructions = `
You are a code-context assistant with retrieval-augmented knowledge.

You have access to:
1) Pre-retrieved context from the last user message (code search, claims, graph).
2) Tools for follow-up: search, list_files, get_file.

Use the retrieval context first. If you need more detail or the context is insufficient, use the tools.
Ground answers in retrieval context or tool output. State clearly when information is missing.
`.trim()

const agent = createAgent({
  model: getModel("medium"),
  tools: [listRepositoriesTool, searchTool, listFilesTool, getFileTool],
  systemPrompt: retrievalAugmentedInstructions,
})

function extractQueryFromMessages(messages: BaseMessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m === "object" && m !== null && "content" in m) {
      const content = (m as { content?: unknown }).content
      if (typeof content === "string" && content.trim()) return content.trim()
      if (Array.isArray(content)) {
        const text = content
          .filter(
            (c): c is { type: string; text?: string } =>
              typeof c === "object" && c !== null,
          )
          .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("")
        if (text.trim()) return text.trim()
      }
    }
  }
  return ""
}

export async function retrievalNode(state: {
  messages: BaseMessageLike[]
}): Promise<{
  messages: BaseMessageLike[]
}> {
  const query = extractQueryFromMessages(state.messages)
  if (!query) {
    return {
      messages: [new AIMessage("No query found in messages.")],
    }
  }

  const orgId = requireCurrentOrgId()
  const orgSlug = requireCurrentOrgSlug()

  const defaultPlan = {
    steps: [{ type: "code_search" as const, params: { query } }],
    depthLimit: 3,
    resultLimit: 20,
  }

  const retrievalState = await retrievalGraph.invoke({
    orgId,
    orgSlug,
    query,
    plan: defaultPlan,
    objectIds: [],
    claimIds: [],
    hybridResults: [],
    codeResults: [],
    graphNodes: [],
    traversalResults: [],
    hydratedClaims: [],
  })

  const contextParts: string[] = []
  if (retrievalState.codeResults?.length) {
    contextParts.push(
      `Code search results:\n${toToon({ codeResults: retrievalState.codeResults })}`,
    )
  }
  if (retrievalState.hydratedClaims?.length) {
    contextParts.push(
      `Claims:\n${toToon({ claims: retrievalState.hydratedClaims })}`,
    )
  }
  const retrievalContext =
    contextParts.length > 0
      ? contextParts.join("\n\n")
      : "No retrieval results."

  const repositories = await listRepositories()
  const repoSnapshot = toToon({
    repositories: repositories.map((r) => ({
      id: r.id,
      name: r.name,
      indexReady: r.indexReady,
      orgId: r.orgId,
    })),
  })

  const inputMessages: BaseMessageLike[] = [
    new SystemMessage(
      `Retrieval context:\n${retrievalContext}\n\nRepositories (TOON):\n${repoSnapshot}`,
    ),
    ...state.messages,
  ]

  const stream = await agent.stream(
    { messages: inputMessages },
    { streamMode: "values" },
  )

  let finalMessages: BaseMessageLike[] | undefined
  for await (const chunk of stream) {
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "messages" in chunk &&
      Array.isArray(chunk.messages)
    ) {
      finalMessages = chunk.messages as BaseMessageLike[]
    }
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

  return { messages: generatedMessages }
}
