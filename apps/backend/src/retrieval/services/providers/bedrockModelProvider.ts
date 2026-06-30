import { ChatOpenAI } from "@langchain/openai"

import {
  createBedrockBearerFetch,
  resolveBedrockRegion,
} from "./bedrockBearer.js"
import type {
  OpenAiCompatibleFetch,
  ProviderCallOpts,
  ProviderCallResult,
} from "./providerTypes.js"

function bearerFetchBedrock(apiKey: string): OpenAiCompatibleFetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${apiKey}`)
    return fetch(input as RequestInfo, { ...init, headers })
  }
}

export function bedrockModelProvider(
  opts: ProviderCallOpts,
): ProviderCallResult {
  const baseURL = opts.env.MODEL_PROVIDER_URL?.trim()
  if (!baseURL) {
    throw new Error("MODEL_PROVIDER_URL is required for MODEL_PROVIDER=bedrock")
  }

  const primary = opts.models[0] ?? ""

  if (opts.apiKey.trim()) {
    return {
      chat: new ChatOpenAI({
        model: primary,
        apiKey: opts.apiKey,
        temperature: opts.temperature,
        streaming: true,
        configuration: { baseURL },
      }),
      fetch: bearerFetchBedrock(opts.apiKey),
    }
  }

  const region = resolveBedrockRegion(opts.env, baseURL)
  if (!region) {
    throw new Error(
      "Bedrock bearer auth requires AWS region: set MODEL_BEDROCK_AWS_REGION or AWS_REGION, or use a MODEL_PROVIDER_URL host like bedrock-mantle.<region>.api.aws",
    )
  }

  const fetchFn = createBedrockBearerFetch(region)
  return {
    chat: new ChatOpenAI({
      model: primary,
      temperature: opts.temperature,
      streaming: true,
      configuration: { baseURL, fetch: fetchFn },
    }),
    fetch: fetchFn,
  }
}
