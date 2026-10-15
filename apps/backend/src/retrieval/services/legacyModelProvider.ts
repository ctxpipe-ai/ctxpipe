import {
  ChatBedrockConverse,
  type ChatBedrockConverseInput,
} from "@langchain/aws"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatOpenAI } from "@langchain/openai"
import {
  type GetModelOptions,
  modelCallSettings,
  resolveChatBaseUrl,
} from "./modelProvider.js"
import { lowerBedrockConverseParams } from "./providers/bedrockModelProvider.js"
import { resolveBedrockRegion } from "./providers/bedrockRegion.js"
import { lowerOpenAiChatCompletionsParams } from "./providers/openAILikeModelProvider.js"
import { lowerOpenRouterParams } from "./providers/openrouterModelProvider.js"
import type { ModelTier } from "./providers/providerTypes.js"

/** Ingestion and Slack retain LangChain until their separate migrations. */
export function getModel(
  tier: ModelTier,
  options?: GetModelOptions,
): BaseChatModel {
  const { provider, callOpts: opts } = modelCallSettings(tier, options)
  if (provider === "bedrock") {
    const params = lowerBedrockConverseParams(opts.modelParams)
    return new ChatBedrockConverse({
      model: opts.models[0] ?? "",
      region: resolveBedrockRegion(opts.env),
      temperature: opts.temperature,
      streaming: opts.streaming ?? true,
      ...params,
      additionalModelRequestFields:
        params?.additionalModelRequestFields as ChatBedrockConverseInput["additionalModelRequestFields"],
    })
  }
  const modelKwargs =
    provider === "openrouter"
      ? {
          plugins: [{ id: "context-compression" }],
          cache_control: { type: "ephemeral" },
          ...lowerOpenRouterParams(opts.modelParams),
          ...(opts.models.length > 1 ? { models: opts.models.slice(1) } : {}),
        }
      : lowerOpenAiChatCompletionsParams(opts.modelParams)
  return new ChatOpenAI({
    model: opts.models[0] ?? "",
    apiKey: opts.apiKey,
    temperature: opts.temperature,
    streaming: opts.streaming ?? true,
    ...(modelKwargs ? { modelKwargs } : {}),
    configuration: {
      baseURL: resolveChatBaseUrl(provider, opts.env.MODEL_PROVIDER_URL),
      ...(provider === "azure"
        ? {
            fetch: (input: RequestInfo | URL, init?: RequestInit) => {
              const headers = new Headers(init?.headers)
              headers.delete("Authorization")
              headers.set("api-key", opts.apiKey)
              return fetch(input, { ...init, headers })
            },
          }
        : {}),
    },
  })
}
