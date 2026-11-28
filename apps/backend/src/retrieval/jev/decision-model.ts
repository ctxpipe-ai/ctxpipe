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
import {
  decisionModelShape,
  dropEmptyEnvValues,
} from "../services/modelTierSpecs.js"
import { openRouterProvider } from "../services/openRouterProvider.js"

/** The Jev model of the OpenRouter Decisions API, the default decision model. */
export const JEV_MODEL = "typesafe/jev-1.14"

export type DecisionModel = {
  provider: NonNullable<
    z.infer<typeof decisionModelShape.DECISION_MODEL_PROVIDER>
  >
  model: string
  apiKey: string
  baseUrl?: string
}

const decisionEnvSchema = z.preprocess(
  dropEmptyEnvValues,
  z.object(decisionModelShape),
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
  const model =
    env.data.DECISION_MODEL_NAME ?? DECISION_PROVIDERS[provider].defaultModel
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

type DecisionCall = {
  adapter: AnyEvaluateAdapter
  modelOptions?: { provider: ReturnType<typeof openRouterProvider> }
}

/**
 * Each decision provider: its default model, and its `decide()` adapter and
 * model options. A call to OpenRouter carries the provider block of ADR-070,
 * so it goes only to ZDR endpoints (ADR-068 decision 7). Another provider
 * gets no OpenRouter field: the data terms of the operator's provider apply.
 */
const DECISION_PROVIDERS: Record<
  DecisionModel["provider"],
  {
    defaultModel: string
    call: (settings: DecisionModel) => DecisionCall
  }
> = {
  openrouter: {
    defaultModel: JEV_MODEL,
    call: ({ model, apiKey, baseUrl }) => ({
      adapter: createOpenRouterDecider(model, apiKey, { baseURL: baseUrl }),
      modelOptions: { provider: openRouterProvider() },
    }),
  },
  openai: {
    defaultModel: "gpt-6-luna",
    // No retry in the SDK: the hedge of `decideNoul` is the only second
    // request, and the time limit is that of the caller.
    call: ({ model, apiKey, baseUrl }) => ({
      adapter: createOpenaiDecider(model, apiKey, {
        baseURL: baseUrl,
        maxRetries: 0,
      }),
    }),
  },
  gemini: {
    defaultModel: "gemini-decision-1",
    call: ({ model, apiKey, baseUrl }) => ({
      adapter: createGeminiDecider(model, apiKey, { baseURL: baseUrl }),
    }),
  },
}

/** The `decide()` adapter and model options of `settings`. */
export function decisionAdapter(settings: DecisionModel): DecisionCall {
  return DECISION_PROVIDERS[settings.provider].call(settings)
}
