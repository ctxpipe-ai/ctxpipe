/**
 * The rule for model settings that can serve the knowledge plane. The plane
 * calls three fixed models: the embedding model, the decision model (Jev)
 * and the vision model. All three are only on OpenRouter. A deployment whose
 * settings fail this rule deploys with no error, but no Workspace becomes
 * ready on the plane.
 *
 * This is the one copy of the rule. The env contract test of the backend
 * (`apps/backend/src/config/deploy-env.contract.test.ts`) applies it to each
 * deployment, and keeps its constants equal to the backend code. The
 * synth check of CTX-1738 can call it too. The values are environment
 * values, as a backend process gets them; an empty value is unset, as in
 * `parseEnv`.
 */

/** The `MODEL_PROVIDER_URL` default of the backend. */
export const OPENROUTER_DEFAULT_URL = "https://openrouter.ai/api/v1"

/** The OpenRouter provider that serves the Jev model. */
export const JEV_PROVIDER = "typesafe"

type KnowledgePlaneSettingsProblem =
  | "not-openrouter"
  | "no-api-key"
  | "allowlist-without-jev"

/**
 * True when the model calls of these settings go to OpenRouter. The backend
 * has the same rule (`isOpenRouterCall`); the contract test keeps them
 * equal.
 */
export function reachesOpenRouter(
  kind: string | undefined,
  url: string | undefined,
): boolean {
  if (kind === "openrouter") return true
  if (kind === "azure" || kind === "bedrock") return false
  try {
    return (
      new URL(url?.trim() || OPENROUTER_DEFAULT_URL).hostname ===
      "openrouter.ai"
    )
  } catch {
    return false
  }
}

/**
 * The first reason why these settings cannot serve the knowledge plane, or
 * undefined when they can.
 */
export function knowledgePlaneSettingsProblem(env: {
  readonly MODEL_PROVIDER?: string
  readonly MODEL_PROVIDER_URL?: string
  readonly MODEL_PROVIDER_API_KEY?: string
  readonly MODEL_PROVIDER_ALLOWLIST?: string
}): { code: KnowledgePlaneSettingsProblem; message: string } | undefined {
  const kind = env.MODEL_PROVIDER?.trim() || undefined
  if (!reachesOpenRouter(kind, env.MODEL_PROVIDER_URL))
    return {
      code: "not-openrouter",
      message: `The knowledge plane needs OpenRouter: its embedding, decision and vision models are only there. Set MODEL_PROVIDER openrouter, or openai-like with a MODEL_PROVIDER_URL on openrouter.ai. Got MODEL_PROVIDER ${kind ?? "openai-like"} and MODEL_PROVIDER_URL ${env.MODEL_PROVIDER_URL?.trim() || OPENROUTER_DEFAULT_URL}.`,
    }
  if (!env.MODEL_PROVIDER_API_KEY?.trim())
    return {
      code: "no-api-key",
      message:
        "The knowledge plane needs MODEL_PROVIDER_API_KEY, the OpenRouter API key.",
    }
  const allowlist = env.MODEL_PROVIDER_ALLOWLIST?.trim()
  if (
    allowlist &&
    !allowlist.split(",").some((slug) => slug.trim() === JEV_PROVIDER)
  )
    return {
      code: "allowlist-without-jev",
      message: `MODEL_PROVIDER_ALLOWLIST must include "${JEV_PROVIDER}", the only provider of the decision model (Jev). Got "${allowlist}".`,
    }
  return undefined
}
