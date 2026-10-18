/** Send every eval model through OpenRouter (CTO decision, 2026-10-18). */

const providerName = "openrouter-eval"

/**
 * Map a `provider/model` id to an OpenRouter id. OpenRouter writes Claude
 * versions with dots and has no date suffix: `anthropic/claude-sonnet-4-5-20250929`
 * becomes `anthropic/claude-sonnet-4.5`. Other ids pass as they are.
 */
export function openRouterModelId(model: string): string {
  const id = model.replace(/^openrouter\//, "")
  const [provider, ...rest] = id.split("/")
  const name = rest.join("/")
  if (!provider || !name)
    throw new Error(`Model "${model}" must look like provider/model.`)
  if (provider !== "anthropic") return id
  return `anthropic/${name
    .replace(/-\d{8}$/, "")
    .replace(/(\d+)-(\d+)(?=$|-)/, "$1.$2")}`
}

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
