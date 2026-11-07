/** Send every eval model through OpenRouter (CTO decision, 2026-10-18). */

import { openRouterModelId } from "@ctxpipe/visual-review"

const providerName = "openrouter-eval"

/** The client settings for one model: base URL from `MODEL_PROVIDER_URL`, key from `MODEL_PROVIDER_API_KEY`. */
export function openRouterClient(
  model: string,
  env: Record<string, string | undefined>,
) {
  const apiKey = env.MODEL_PROVIDER_API_KEY
  if (!apiKey)
    throw new Error(
      `Set MODEL_PROVIDER_API_KEY (the OpenRouter key) for ${model}.`,
    )
  const baseUrl = env.MODEL_PROVIDER_URL || "https://openrouter.ai/api/v1"
  const id = openRouterModelId(model)
  return {
    // The model name the SDK receives; `model` stays the report key.
    sdkModel: `${providerName}/${id}`,
    apiKey,
    customProviders: {
      [providerName]: {
        name: providerName,
        protocol: "openai-compatible" as const,
        baseUrl,
        modelIds: [id],
        useChatCompletions: true,
      },
    },
  }
}
