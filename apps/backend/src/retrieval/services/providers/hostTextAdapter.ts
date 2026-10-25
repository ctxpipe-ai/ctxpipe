import {
  type AdapterYieldChunk,
  EventType,
  type JSONSchema,
  type TextOptions,
  type TokenUsage,
} from "@tanstack/ai"
import type { StructuredOutputOptions } from "@tanstack/ai/adapters"
import { BaseTextAdapter } from "@tanstack/ai/adapters"

import { withLangfuseGeneration } from "../../../observability/langfuse.js"
import type { ProviderCallOpts } from "./providerTypes.js"

/** Name of the forced tool that carries a structured reply. */
export const STRUCTURED_OUTPUT_TOOL = "structured_output"

/**
 * One provider request. With a schema, the provider forces the structured
 * output tool and `text` holds the JSON arguments of that tool call.
 */
type HostRequest = (
  options: TextOptions,
  schema?: JSONSchema,
) => Promise<{ text: string; usage?: TokenUsage }>

/** Plain text of a TanStack message, as the providers accept it. */
export function messageText(
  content: TextOptions["messages"][number]["content"],
) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      typeof part === "object" && part && "content" in part
        ? String(part.content)
        : "",
    )
    .join("")
}

/** Host calls use a single response, also when TanStack consumes events. */
export class HostTextAdapter extends BaseTextAdapter<
  string,
  Record<string, never>,
  ["text"],
  never
> {
  constructor(
    opts: ProviderCallOpts,
    readonly name: string,
    private readonly request: HostRequest,
    private readonly generationName = opts.name ?? "modelProvider.chat",
  ) {
    super({}, opts.models[0] ?? "")
  }

  /** One request, recorded as one Langfuse generation. */
  private call(options: TextOptions, schema?: JSONSchema) {
    return withLangfuseGeneration(
      {
        name: this.generationName,
        model: this.model,
        input: {
          systemPrompts: options.systemPrompts,
          messages: options.messages.map((message) => ({
            role: message.role,
            content: messageText(message.content),
          })),
          ...(schema ? { structured: true } : {}),
        },
        metadata: { provider: this.name },
        summarizeOutput: (result) => ({ text: result.text }),
        usageFromResult: (result) =>
          result.usage
            ? {
                input: result.usage.promptTokens,
                output: result.usage.completionTokens,
                total: result.usage.totalTokens,
              }
            : undefined,
      },
      () => this.request(options, schema),
    )
  }

  async *chatStream(options: TextOptions): AsyncIterable<AdapterYieldChunk> {
    options.logger.request(`provider=${this.name} model=${this.model}`)
    const response = await this.call(options)
    const runId = options.runId ?? this.generateId()
    const threadId = options.threadId ?? this.generateId()
    const messageId = this.generateId()
    yield {
      type: EventType.RUN_STARTED,
      threadId,
      runId,
      timestamp: Date.now(),
    }
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
      timestamp: Date.now(),
    }
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: response.text,
      timestamp: Date.now(),
    }
    yield { type: EventType.TEXT_MESSAGE_END, messageId, timestamp: Date.now() }
    yield {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      finishReason: "stop",
      usage: response.usage,
      timestamp: Date.now(),
    }
  }

  async structuredOutput(
    options: StructuredOutputOptions<Record<string, never>>,
  ) {
    const response = await this.call(options.chatOptions, options.outputSchema)
    return {
      data: JSON.parse(response.text) as unknown,
      rawText: response.text,
      usage: response.usage,
    }
  }
}
