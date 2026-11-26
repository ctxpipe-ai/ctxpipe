// The decision model of the knowledge plane (ADR-068): the model that
// answers the typed questions of the layer judge and of the disagreement
// check. The calls go through the `decide()` activity of TanStack AI with the
// adapter of the configured provider. With no decision settings, the model is
// Jev on OpenRouter with the `MODEL_PROVIDER_*` values (the hosted setup).
import type { AnyEvaluateAdapter } from "@tanstack/ai"
import { createGeminiDecider } from "@tanstack/ai-gemini"
import { createOpenaiDecider } from "@tanstack/ai-openai"
import { createOpenRouterDecider } from "@tanstack/ai-openrouter"
import { z } from "zod"

import { openRouterSettings } from "../services/modelProvider.js"
import { dropEmptyEnvValues } from "../services/modelTierSpecs.js"
import { openRouterProvider } from "../services/openRouterProvider.js"

/** The Jev model of the OpenRouter Decisions API, the default decision model. */
export const JEV_MODEL = "typesafe/jev-1.14"

/** The model of each provider when `DECISION_MODEL_NAME` is not set. */
const DEFAULT_MODELS = {
  openrouter: JEV_MODEL,
  openai: "gpt-6-luna",
  gemini: "gemini-decision-1",
} as const

const decisionProviderSchema = z.enum(["openrouter", "openai", "gemini"])

type DecisionModel = {
  provider: z.infer<typeof decisionProviderSchema>
  model: string
  apiKey: string
  baseUrl?: string
}

const decisionEnvSchema = z.preprocess(
  dropEmptyEnvValues,
  z.object({
    DECISION_MODEL_PROVIDER: decisionProviderSchema.optional(),
    DECISION_MODEL_NAME: z.string().trim().min(1).optional(),
    DECISION_MODEL_URL: z.string().url().optional(),
    DECISION_MODEL_API_KEY: z.string().optional(),
  }),
)

/**
 * The decision model of the backend settings, or null when the settings
 * cannot reach one. `DECISION_MODEL_PROVIDER` (default `openrouter`) and
 * `DECISION_MODEL_NAME` (default: the model of the provider) select the
 * model. `DECISION_MODEL_URL` and `DECISION_MODEL_API_KEY` give the
 * endpoint. For OpenRouter with no `DECISION_MODEL_API_KEY`, the model
 * settings give the URL and the key (`openRouterSettings`). A Bedrock or
 * Azure install must set a decision key of its own: no decision model is on
 * Bedrock or Azure.
 */
export function decisionModelSettings(): DecisionModel | null {
  const env = decisionEnvSchema.safeParse(process.env)
  if (!env.success) return null
  const provider = env.data.DECISION_MODEL_PROVIDER ?? "openrouter"
  const model = env.data.DECISION_MODEL_NAME ?? DEFAULT_MODELS[provider]
  const apiKey = env.data.DECISION_MODEL_API_KEY
  const baseUrl = env.data.DECISION_MODEL_URL
  if (apiKey) return { provider, model, apiKey, baseUrl }
  if (provider !== "openrouter") return null
  const modelSettings = openRouterSettings()
  if (!modelSettings) return null
  return {
    provider,
    model,
    apiKey: modelSettings.apiKey,
    baseUrl: baseUrl ?? modelSettings.base,
  }
}

/**
 * The `decide()` adapter and model options of `settings`. A call to
 * OpenRouter carries the provider block of ADR-070, so it goes only to ZDR
 * endpoints (ADR-068 decision 7). Another provider gets no OpenRouter field:
 * the data terms of the operator's provider apply.
 */
export function decisionAdapter(settings: DecisionModel): {
  adapter: AnyEvaluateAdapter
  modelOptions?: { provider: Record<string, unknown> }
} {
  const { provider, model, apiKey, baseUrl } = settings
  switch (provider) {
    case "openrouter":
      return {
        adapter: createOpenRouterDecider(model, apiKey, { baseURL: baseUrl }),
        modelOptions: { provider: openRouterProvider() },
      }
    case "openai":
      // No retry in the SDK: the hedge of `decideNoul` is the only second
      // request, and the time limit is that of the caller.
      return {
        adapter: createOpenaiDecider(model, apiKey, {
          baseURL: baseUrl,
          maxRetries: 0,
        }),
      }
    case "gemini":
      return {
        adapter: createGeminiDecider(model, apiKey, { baseURL: baseUrl }),
      }
  }
}
