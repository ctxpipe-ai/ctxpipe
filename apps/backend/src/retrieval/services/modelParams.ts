import { z } from "zod"

export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const

export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number]

export const VERBOSITY_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export type Verbosity = (typeof VERBOSITY_VALUES)[number]

const reasoningParamsSchema = z
  .object({
    effort: z.enum(REASONING_EFFORT_VALUES).optional(),
    maxTokens: z.number().int().positive().optional(),
    exclude: z.boolean().optional(),
    enabled: z.boolean().optional(),
    summary: z.string().optional(),
  })
  .strict()

const textParamsSchema = z
  .object({
    verbosity: z.enum(VERBOSITY_VALUES).optional(),
  })
  .strict()

const samplingParamsSchema = z
  .object({
    maxTokens: z.number().int().positive().optional(),
    topP: z.number().min(0).max(1).optional(),
    seed: z.number().int().optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
  })
  .strict()

const providerNamespaceSchema = z.record(z.string(), z.unknown())

export const modelParamsSchema = z
  .object({
    reasoning: reasoningParamsSchema.optional(),
    text: textParamsSchema.optional(),
    sampling: samplingParamsSchema.optional(),
    openrouter: providerNamespaceSchema.optional(),
    bedrock: providerNamespaceSchema.optional(),
    azure: providerNamespaceSchema.optional(),
  })
  .strict()

export type ModelParams = z.infer<typeof modelParamsSchema>

const CANONICAL_TOP_LEVEL_KEYS = new Set([
  "reasoning",
  "text",
  "sampling",
  "openrouter",
  "bedrock",
  "azure",
])

function coerceQueryValue(value: string): string | number | boolean {
  if (value === "true") return true
  if (value === "false") return false
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value)
  return value
}

function nestQueryParams(params: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const [key, rawValue] of Object.entries(params)) {
    const parts = key.split(".")
    if (parts.length === 0) continue

    const topLevel = parts[0]
    if (topLevel === undefined || !CANONICAL_TOP_LEVEL_KEYS.has(topLevel)) {
      throw new Error(
        `Unknown model spec param "${key}"; allowed top-level keys: ${[...CANONICAL_TOP_LEVEL_KEYS].join(", ")}`,
      )
    }

    let cursor: Record<string, unknown> = out
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (part === undefined) continue
      const next = cursor[part]
      if (next === undefined || typeof next !== "object" || next === null) {
        cursor[part] = {}
      }
      cursor = cursor[part] as Record<string, unknown>
    }

    const leaf = parts[parts.length - 1]
    if (leaf !== undefined) {
      cursor[leaf] = coerceQueryValue(rawValue)
    }
  }

  return out
}

export function paramsToModelParams(params: Record<string, string>): ModelParams {
  const nested = nestQueryParams(params)
  const parsed = modelParamsSchema.safeParse(nested)
  if (!parsed.success) {
    throw new Error(
      `Invalid model spec params: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    )
  }
  return parsed.data
}

export function mergeModelParams(
  base: ModelParams,
  override: ModelParams,
): ModelParams {
  return modelParamsSchema.parse(deepMerge(base, override))
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(
        out[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      out[key] = value
    }
  }
  return out
}

export function isEmptyModelParams(params: ModelParams | undefined): boolean {
  if (!params) return true
  return Object.keys(params).length === 0
}

export function restrictModelParamsForProvider(
  params: ModelParams | undefined,
  provider: "openai-like" | "openrouter" | "azure" | "bedrock",
): ModelParams | undefined {
  if (!params) return undefined

  const { openrouter, bedrock, azure, reasoning, text, sampling } = params
  const canonical: ModelParams = {}
  if (reasoning) canonical.reasoning = reasoning
  if (text) canonical.text = text
  if (sampling) canonical.sampling = sampling

  if (provider === "openrouter" && openrouter) {
    canonical.openrouter = openrouter
  }
  if (provider === "bedrock" && bedrock) {
    canonical.bedrock = bedrock
  }
  if (provider === "azure" && azure) {
    canonical.azure = azure
  }

  return isEmptyModelParams(canonical) ? undefined : canonical
}
