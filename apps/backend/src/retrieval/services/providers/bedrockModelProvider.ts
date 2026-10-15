import type { ToolInputSchema } from "@aws-sdk/client-bedrock-runtime"
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import type { ModelParams } from "../modelParams.js"
import { invokeBedrockEmbedding } from "./bedrockEmbeddings.js"
import { resolveBedrockRegion } from "./bedrockRegion.js"
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

function isNonEmptyRecord(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

/** Map canonical parameters to native Bedrock Converse fields. */
export function lowerBedrockConverseParams(params: ModelParams | undefined):
  | {
      maxTokens?: number
      topP?: number
      additionalModelRequestFields?: Record<string, unknown>
    }
  | undefined {
  if (!params) return undefined

  const additionalModelRequestFields: Record<string, unknown> = {}
  let maxTokens: number | undefined
  let topP: number | undefined

  if (params.reasoning?.effort !== undefined) {
    additionalModelRequestFields.reasoning_effort = params.reasoning.effort
  }

  if (params.text?.verbosity !== undefined) {
    additionalModelRequestFields.verbosity = params.text.verbosity
  }

  if (params.sampling?.maxTokens !== undefined) {
    maxTokens = params.sampling.maxTokens
  }
  if (params.sampling?.topP !== undefined) {
    topP = params.sampling.topP
  }

  if (params.bedrock && isNonEmptyRecord(params.bedrock)) {
    Object.assign(additionalModelRequestFields, params.bedrock)
  }

  const out: {
    maxTokens?: number
    topP?: number
    additionalModelRequestFields?: Record<string, unknown>
  } = {}

  if (maxTokens !== undefined) out.maxTokens = maxTokens
  if (topP !== undefined) out.topP = topP
  if (isNonEmptyRecord(additionalModelRequestFields)) {
    out.additionalModelRequestFields = additionalModelRequestFields
  }

  return Object.keys(out).length > 0 ? out : undefined
}

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
  const region = resolveBedrockRegion(opts.env)
  const primary = opts.models[0] ?? ""
  const converseParams = lowerBedrockConverseParams(opts.modelParams)

  return {
    chat: new HostTextAdapter(opts, "bedrock", async (options, schema) => {
      // Node transport on every runtime, so each call sends one plain HTTP request.
      const client = new BedrockRuntimeClient({
        region,
        maxAttempts: 3,
        requestHandler: new NodeHttpHandler(),
      })
      const response = await client
        .send(
          new ConverseCommand({
            modelId: primary,
            messages: options.messages.map((message) => ({
              role: message.role === "assistant" ? "assistant" : "user",
              content: [{ text: messageText(message.content) }],
            })),
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
            system: options.systemPrompts?.map((prompt) => ({
              text: typeof prompt === "string" ? prompt : prompt.content,
            })),
            inferenceConfig: {
              temperature: opts.temperature,
              maxTokens: converseParams?.maxTokens,
              topP: converseParams?.topP,
            },
            additionalModelRequestFields:
              converseParams?.additionalModelRequestFields as
                | ConverseCommandInput["additionalModelRequestFields"]
                | undefined,
          }),
          { abortSignal: options.request?.signal ?? undefined },
        )
        .finally(() => client.destroy())
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
    embed: async (text: string) => {
      const modelId = opts.models[0] ?? ""
      return invokeBedrockEmbedding(text, modelId, opts.env)
    },
  }
}
