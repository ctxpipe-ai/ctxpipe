import { ChatOpenAI } from "@langchain/openai"

import { lowerOpenAiChatCompletionsParams } from "./openAILikeModelProvider.js"
import type {
  OpenAiCompatibleFetch,
  ProviderCallOpts,
  ProviderCallResult,
} from "./providerTypes.js"

/** Azure OpenAI: `api-key` header, not Bearer — strip Authorization from the client. */
function azureFetch(apiKey: string): OpenAiCompatibleFetch {
  return async (input, init): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.delete("Authorization")
    headers.set("api-key", apiKey)
    return fetch(input as RequestInfo, { ...init, headers })
  }
}

export function azureModelProvider(opts: ProviderCallOpts): ProviderCallResult {
  const baseURL = opts.env.MODEL_PROVIDER_URL?.trim()
  if (!baseURL) {
    throw new Error("MODEL_PROVIDER_URL is required for MODEL_PROVIDER=azure")
  }

  const primary = opts.models[0] ?? ""
  const modelKwargs = lowerOpenAiChatCompletionsParams(opts.modelParams)
  const fetchFn = azureFetch(opts.apiKey)
  return {
    chat: new ChatOpenAI({
      model: primary,
      apiKey: opts.apiKey,
      temperature: opts.temperature,
      streaming: opts.streaming ?? true,
      ...(modelKwargs ? { modelKwargs } : {}),
      configuration: { baseURL, fetch: fetchFn },
    }),
    fetch: fetchFn,
  }
}
