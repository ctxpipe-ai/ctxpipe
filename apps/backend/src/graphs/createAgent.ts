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

/** Defaults for long-running conversation agents (unchanged legacy behavior). */
const DEFAULT_CLEAR_TOOL_TRIGGER_TOKENS = 380_000
const DEFAULT_CLEAR_TOOL_KEEP_MESSAGES = 14
const DEFAULT_SUMMARY_TRIGGER_TOKENS = 520_000
const DEFAULT_SUMMARY_KEEP_MESSAGES = 40

export type CreateAgentContextMiddleware = {
  /** Approximate token count before clearing older tool outputs (per LangChain context editing). */
  clearToolUsesTriggerTokens?: number
  /** Recent messages to keep when clearing tool outputs. */
  clearToolUsesKeepMessages?: number
  /** Approximate token count before summarizing older history. */
  summarizationTriggerTokens?: number
  /** Recent messages to keep when summarizing. */
  summarizationKeepMessages?: number
}

export type CreateAgentParams = {
  model: ChatOpenAI
  tools: readonly (ClientTool | ServerTool)[]
  systemPrompt: string
  /**
   * Optional per-call tuning for context editing + summarization middleware.
   * When omitted, uses {@link DEFAULT_CLEAR_TOOL_TRIGGER_TOKENS} / {@link DEFAULT_SUMMARY_TRIGGER_TOKENS}
   * so conversation agents stay unchanged. Code-ingestion nodes pass lower triggers so tool-heavy
   * runs actually clear/summarize before the conversation is enormous.
   */
  contextMiddleware?: CreateAgentContextMiddleware
}

/**
 * App-wide ReAct agent: LangChain `createAgent` plus context middleware so long tool-heavy
 * runs stay within model limits (clear old tool outputs, summarize history).
 */
export function createAgent(params: CreateAgentParams) {
  const clearTrigger =
    params.contextMiddleware?.clearToolUsesTriggerTokens ??
    DEFAULT_CLEAR_TOOL_TRIGGER_TOKENS
  const clearKeep =
    params.contextMiddleware?.clearToolUsesKeepMessages ??
    DEFAULT_CLEAR_TOOL_KEEP_MESSAGES
  const summaryTrigger =
    params.contextMiddleware?.summarizationTriggerTokens ??
    DEFAULT_SUMMARY_TRIGGER_TOKENS
  const summaryKeep =
    params.contextMiddleware?.summarizationKeepMessages ??
    DEFAULT_SUMMARY_KEEP_MESSAGES

  return createLangchainAgent({
    model: params.model,
    tools: [...params.tools],
    systemPrompt: params.systemPrompt,
    middleware: [
      contextEditingMiddleware({
        tokenCountMethod: "approx",
        edits: [
          new ClearToolUsesEdit({
            trigger: { tokens: clearTrigger },
            keep: { messages: clearKeep },
            placeholder:
              "[cleared prior tool output to stay within context limits]",
          }),
        ],
      }),
      summarizationMiddleware({
        model: params.model,
        trigger: { tokens: summaryTrigger },
        keep: { messages: summaryKeep },
        tokenCounter: (messages: BaseMessage[]) =>
          countTokensApproximately(messages),
      }),
    ],
  })
}
