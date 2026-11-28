/**
 * The rule for model settings that can serve the knowledge plane. The plane
 * calls three fixed models: the embedding model, the decision model (Jev)
 * and the vision model. All three are only on OpenRouter. With settings
 * that fail this rule, no Workspace becomes ready on the plane.
 *
 * This is the one copy of the rule. The worker applies it at start and
 * before each projection (`apps/backend/src/knowledge-plane/model-settings.ts`);
 * the backend images copy this file for that. The env contract test
 * (`apps/backend/src/config/deploy-env-contract.ts`) applies it to the
 * construct and to Compose, and the synth check of CTX-1738 can call it.
 * Keep the file free of imports. The values are environment values, as a
 * backend process gets them; an empty value is unset, as in `parseEnv`.
 */

/** The `MODEL_PROVIDER_URL` default of the backend. */
export const OPENROUTER_DEFAULT_URL = "https://openrouter.ai/api/v1"

/** The OpenRouter provider that serves the Jev model. */
export const JEV_PROVIDER = "typesafe"

/**
 * The first reason why these settings cannot serve the knowledge plane, or
 * undefined when they can:
 * - `not-openrouter`: the model calls do not go to OpenRouter. The kind
 *   `openrouter` takes any valid URL, for a gateway in front of OpenRouter.
 * - `no-api-key`: no `MODEL_PROVIDER_API_KEY`.
 * - `allowlist-without-jev`: `MODEL_PROVIDER_ALLOWLIST` does not allow the
 *   provider of Jev.
 */
export function knowledgePlaneSettingsProblem(
  env: Readonly<Record<string, string | undefined>>,
): "not-openrouter" | "no-api-key" | "allowlist-without-jev" | undefined {
  const kind = env.MODEL_PROVIDER?.trim() || "openai-like"
  let host: string | undefined
  try {
    host = new URL(env.MODEL_PROVIDER_URL?.trim() || OPENROUTER_DEFAULT_URL)
      .hostname
  } catch {
    host = undefined
  }
  if (
    !host ||
    !(
      kind === "openrouter" ||
      (kind === "openai-like" && host === "openrouter.ai")
    )
  )
    return "not-openrouter"
  if (!env.MODEL_PROVIDER_API_KEY?.trim()) return "no-api-key"
  const allowlist = env.MODEL_PROVIDER_ALLOWLIST?.trim()
  if (
    allowlist &&
    !allowlist.split(",").some((slug) => slug.trim() === JEV_PROVIDER)
  )
    return "allowlist-without-jev"
  return undefined
}
