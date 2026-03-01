import type { BaseMessageLike } from "@langchain/core/messages"
import { AIMessage, SystemMessage } from "@langchain/core/messages"
import { createAgent } from "langchain"
import { listRepositories } from "src/models/repositories.js"
import { getModel } from "../../../config/models.js"
import { toToon } from "../../../lib/agentToolRuntime.js"
import { getFileTool } from "../../../tools/getFile.js"
import { listFilesTool } from "../../../tools/listFiles.js"
import { listRepositoriesTool } from "../../../tools/listRepositories.js"
import { searchTool } from "../../../tools/search.js"

const codeInterpretterInstructions = `
You are codeInterpretter, a repository-aware codebase assistant.

You answer questions about the platform codebase using tools.
Repository list is already included in the system message, so you do not need to call list_repositories first.

Workflow:
1) Pick one or more repositoryId values from the provided repository snapshot (prefix: repo_).
2) Use search for broad discovery in a repository using Zoekt query syntax.
3) Use list_files for structural exploration.
4) Use get_file for exact evidence and quote findings.

Ground every answer in tool output only. If information is missing or repositories are not indexed, state that clearly.
Prefer concise answers with repository-level evidence.
`.trim()

const agent = createAgent({
  model: getModel("fast"),
  tools: [listRepositoriesTool, searchTool, listFilesTool, getFileTool],
  systemPrompt: codeInterpretterInstructions,
})

export async function codeInterpretter(state: {
  messages: BaseMessageLike[]
}): Promise<{
  messages: BaseMessageLike[]
}> {
  const repositories = await listRepositories()
  if (repositories.length === 0) {
    return {
      messages: [new AIMessage("No repositories are currently available.")],
    }
  }

  const repoSnapshot = toToon({
    repositories: repositories.map((repository) => ({
      id: repository.id,
      name: repository.name,
      indexReady: repository.indexReady,
      orgId: repository.orgId,
    })),
  })
  const inputMessages: BaseMessageLike[] = [
    new SystemMessage(`Repositories snapshot (TOON):\n${repoSnapshot}`),
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
