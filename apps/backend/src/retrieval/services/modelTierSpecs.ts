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
  MODEL_HIGH_NAME: z.string().default("xiaomi/mimo-v2.6-pro"),
  MODEL_EMBEDDING_NAME: z.string().default("openai/text-embedding-3-large"),
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

/** The model spec of a tier for an environment, with the shared defaults. */
export function tierModelSpecFromEnv(
  tier: ModelTier,
  env: Record<string, string | undefined>,
): string {
  return tierModelSpec(tier, modelNamesSchema.parse(env))
}
