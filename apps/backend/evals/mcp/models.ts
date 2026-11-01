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

/** USD for one token of input and of output. */
export type Price = { input: number; output: number }

/**
 * The prices of the given OpenRouter model ids, from `GET {baseUrl}/models`
 * (no key needed). A model without a listed price, or a list that does not
 * load, has no entry: its cost is then unknown, not zero.
 */
export async function openRouterPrices(
  baseUrl: string,
  ids: readonly string[],
): Promise<Map<string, Price>> {
  const prices = new Map<string, Price>()
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return prices
    const { data } = (await response.json()) as {
      data?: {
        id: string
        pricing?: { prompt?: string; completion?: string }
      }[]
    }
    for (const model of data ?? []) {
      const input = Number(model.pricing?.prompt)
      const output = Number(model.pricing?.completion)
      if (
        ids.includes(model.id) &&
        Number.isFinite(input) &&
        Number.isFinite(output)
      )
        prices.set(model.id, { input, output })
    }
  } catch {
    // No price list: the cost stays unknown.
  }
  return prices
}

/** The cost in USD of the tokens of one model, or undefined without a price. */
export function usageCost(
  tokens: { inputTokens: number; outputTokens: number },
  price: Price | undefined,
): number | undefined {
  if (!price) return undefined
  return tokens.inputTokens * price.input + tokens.outputTokens * price.output
}
