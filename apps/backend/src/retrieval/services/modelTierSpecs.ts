import { z } from "zod"

import type { ModelTier } from "./providers/providerTypes.js"

/** An empty value is unset, as in `parseEnv`: Compose passes unset settings as "". */
export function dropEmptyEnvValues(env: unknown) {
  return Object.fromEntries(
    Object.entries(env as Record<string, string | undefined>).filter(
      ([, value]) => value?.trim() !== "",
    ),
  )
}

/** The model name settings and their defaults: the one source for every caller. */
export const modelNameShape = {
  MODEL_FAST_NAME: z
    .string()
    .default("openai/gpt-6-luna?reasoning.effort=high"),
  MODEL_MEDIUM_NAME: z
    .string()
    .default("openai/gpt-6-luna?reasoning.effort=xhigh"),
  MODEL_HIGH_NAME: z
    .string()
    .default("openai/gpt-6-luna?reasoning.effort=xhigh"),
  MODEL_EMBEDDING_NAME: z.string().default("openai/text-embedding-3-large"),
  /**
   * The one OpenRouter model that reads the images of the knowledge plane
   * (ADR-068 decision 6). The default is the choice of the vision eval. It
   * must take image input and a JSON schema, and have a ZDR endpoint.
   */
  MODEL_VISION_NAME: z
    .string()
    .trim()
    .min(1, "MODEL_VISION_NAME must name one OpenRouter model")
    .default("openai/gpt-6.1-terra"),
}

/**
 * The decision model settings of the knowledge plane
 * (`decisionModelSettings`): the one source for the start check of the
 * backend and for the decision client. All are optional: with none set, the
 * decision model is Jev on OpenRouter with the `MODEL_PROVIDER_*` values.
 */
export const decisionModelShape = {
  DECISION_MODEL_PROVIDER: z
    .enum(["openrouter", "openai", "gemini"])
    .optional(),
  DECISION_MODEL_NAME: z.string().trim().min(1).optional(),
  DECISION_MODEL_URL: z.string().url().optional(),
  DECISION_MODEL_API_KEY: z.string().min(1).optional(),
}

const modelNamesSchema = z.preprocess(
  dropEmptyEnvValues,
  z.object(modelNameShape),
)

export function tierModelSpec(
  tier: ModelTier,
  env: Pick<
    z.infer<z.ZodObject<typeof modelNameShape>>,
    "MODEL_FAST_NAME" | "MODEL_MEDIUM_NAME" | "MODEL_HIGH_NAME"
  >,
): string {
  if (tier === "fast") return env.MODEL_FAST_NAME
  if (tier === "medium") return env.MODEL_MEDIUM_NAME
  return env.MODEL_HIGH_NAME
}

/** The vision model of an environment (`MODEL_VISION_NAME`, else its default). */
export function visionModelFromEnv(
  env: Record<string, string | undefined>,
): string {
  return modelNamesSchema.parse(env).MODEL_VISION_NAME
}

/** The model spec of a tier for an environment, with the shared defaults. */
export function tierModelSpecFromEnv(
  tier: ModelTier,
  env: Record<string, string | undefined>,
): string {
  return tierModelSpec(tier, modelNamesSchema.parse(env))
}
