import type { BaseMessage } from "@langchain/core/messages"
import type { ClientTool, ServerTool } from "@langchain/core/tools"
import type { ChatOpenAI } from "@langchain/openai"
import {
  ClearToolUsesEdit,
  contextEditingMiddleware,
  countTokensApproximately,
  createAgent as createLangchainAgent,
  summarizationMiddleware,
} from "langchain"

const CLEAR_TOOL_TRIGGER_TOKENS = 380_000
const CLEAR_TOOL_KEEP_MESSAGES = 14
const SUMMARY_TRIGGER_TOKENS = 520_000
const SUMMARY_KEEP_MESSAGES = 40

export type CreateAgentParams = {
  model: ChatOpenAI
  tools: readonly (ClientTool | ServerTool)[]
  systemPrompt: string
}

/**
 * App-wide ReAct agent: LangChain `createAgent` plus context middleware so long tool-heavy
 * runs stay within model limits (clear old tool outputs, summarize history).
 */
export function createAgent(params: CreateAgentParams) {
  return createLangchainAgent({
    model: params.model,
    tools: [...params.tools],
    systemPrompt: params.systemPrompt,
    middleware: [
      contextEditingMiddleware({
        tokenCountMethod: "approx",
        edits: [
          new ClearToolUsesEdit({
            trigger: { tokens: CLEAR_TOOL_TRIGGER_TOKENS },
            keep: { messages: CLEAR_TOOL_KEEP_MESSAGES },
            placeholder:
              "[cleared prior tool output to stay within context limits]",
          }),
        ],
      }),
      summarizationMiddleware({
        model: params.model,
        trigger: { tokens: SUMMARY_TRIGGER_TOKENS },
        keep: { messages: SUMMARY_KEEP_MESSAGES },
        tokenCounter: (messages: BaseMessage[]) =>
          countTokensApproximately(messages),
      }),
    ],
  })
}
