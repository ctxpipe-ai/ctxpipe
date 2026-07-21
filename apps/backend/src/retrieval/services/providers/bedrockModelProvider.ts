import { ChatBedrockConverse } from "@langchain/aws"

import type { ModelParams } from "../modelParams.js"
import { invokeBedrockEmbedding } from "./bedrockEmbeddings.js"
import { resolveBedrockRegion } from "./bedrockRegion.js"
import type {
  OpenAiCompatibleFetch,
  ProviderCallOpts,
  ProviderCallResult,
} from "./providerTypes.js"

function isNonEmptyRecord(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

/** Bedrock Converse chat via `ChatBedrockConverse` inference fields. */
export function lowerBedrockConverseParams(
  params: ModelParams | undefined,
): {
  maxTokens?: number
  topP?: number
  additionalModelRequestFields?: Record<string, unknown>
} | undefined {
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
    chat: new ChatBedrockConverse({
      model: primary,
      region,
      temperature: opts.temperature,
      streaming: opts.streaming ?? true,
      ...(converseParams?.maxTokens !== undefined
        ? { maxTokens: converseParams.maxTokens }
        : {}),
      ...(converseParams?.topP !== undefined ? { topP: converseParams.topP } : {}),
      ...(converseParams?.additionalModelRequestFields
        ? {
            additionalModelRequestFields:
              converseParams.additionalModelRequestFields,
          }
        : {}),
    }),
    fetch: bedrockFetchNotSupported(),
    embed: async (text: string) => {
      const modelId = opts.models[0] ?? ""
      return invokeBedrockEmbedding(text, modelId, opts.env)
    },
  }
}
