import {
  ConverseCommand,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime"

import { bedrockConverseInput, withBedrockClient } from "./bedrockConverse.js"
import { invokeBedrockEmbedding } from "./bedrockEmbeddings.js"
import {
  HostTextAdapter,
  messageText,
  STRUCTURED_OUTPUT_TOOL,
} from "./hostTextAdapter.js"
import type {
  OpenAiCompatibleFetch,
  ProviderCallOpts,
  ProviderCallResult,
} from "./providerTypes.js"

function bedrockFetchNotSupported(): OpenAiCompatibleFetch {
  return async () => {
    throw new Error(
      "Bedrock HTTP fetch is not supported; use native Bedrock SDK paths",
    )
  }
}

export function bedrockModelProvider(
  opts: ProviderCallOpts,
): ProviderCallResult {
  const primary = opts.models[0] ?? ""

  return {
    chat: new HostTextAdapter(opts, "bedrock", async (options, schema) => {
      const response = await withBedrockClient(opts.env, (client) =>
        client.send(
          new ConverseCommand({
            ...bedrockConverseInput(
              primary,
              [
                ...(options.systemPrompts ?? []).map((prompt) => ({
                  role: "system",
                  content: typeof prompt === "string" ? prompt : prompt.content,
                })),
                ...options.messages.map((message) => ({
                  role: message.role,
                  content: messageText(message.content),
                })),
              ],
              opts.temperature,
              opts.modelParams,
            ),
            ...(schema
              ? {
                  toolConfig: {
                    tools: [
                      {
                        toolSpec: {
                          name: opts.outputName ?? STRUCTURED_OUTPUT_TOOL,
                          inputSchema: { json: schema } as ToolInputSchema,
                        },
                      },
                    ],
                    toolChoice: {
                      tool: { name: opts.outputName ?? STRUCTURED_OUTPUT_TOOL },
                    },
                  },
                }
              : {}),
          }),
          { abortSignal: options.request?.signal ?? undefined },
        ),
      )
      const parts = response.output?.message?.content ?? []
      const toolInput = parts.find(
        (part) =>
          part.toolUse?.name === (opts.outputName ?? STRUCTURED_OUTPUT_TOOL),
      )?.toolUse?.input
      if (schema && toolInput === undefined)
        throw new Error("The model did not call the structured output tool")
      return {
        text: schema
          ? JSON.stringify(toolInput)
          : parts.map((part) => part.text ?? "").join(""),
        usage: response.usage
          ? {
              promptTokens: response.usage.inputTokens ?? 0,
              completionTokens: response.usage.outputTokens ?? 0,
              totalTokens: response.usage.totalTokens ?? 0,
            }
          : undefined,
      }
    }),
    fetch: bedrockFetchNotSupported(),
    embed: async (text: string, signal?: AbortSignal) => {
      const modelId = opts.models[0] ?? ""
      return invokeBedrockEmbedding(text, modelId, opts.env, signal)
    },
  }
}
