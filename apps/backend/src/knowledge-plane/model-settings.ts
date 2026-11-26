import { log } from "../observability/logger.js"
import { openRouterSettings } from "../retrieval/services/modelProvider.js"
import { isOpenRouterCall } from "../retrieval/services/openRouterProvider.js"

/**
 * True when the model settings send the calls of Jev, the plane embeddings
 * and the vision model to OpenRouter, with a key. These models are only on
 * OpenRouter (ADR-068 decisions 5 and 7). Thus an install with
 * `MODEL_PROVIDER` `bedrock` or `azure`, with an `openai-like` URL of
 * another API, or with no key cannot serve the plane. This is the one check
 * of these settings: the projection and the start log of the worker use it.
 */
export function planeModelsReachable(): boolean {
  return (
    openRouterSettings() !== null &&
    isOpenRouterCall(process.env.MODEL_PROVIDER, process.env.MODEL_PROVIDER_URL)
  )
}

/**
 * Logs one error at the start of the worker when the model settings cannot
 * serve the plane. No Workspace of such an install becomes ready (the
 * projection checks the same settings), so its orgs keep the old stack.
 */
export function checkKnowledgePlaneModelSettings(): void {
  if (planeModelsReachable()) return
  log.error({
    step: "knowledge_plane.model_settings",
    message:
      "The knowledge plane needs MODEL_PROVIDER openrouter, or openai-like with a MODEL_PROVIDER_URL on openrouter.ai, and MODEL_PROVIDER_API_KEY. Without them, no Workspace becomes ready on the plane, and the old knowledge stack answers.",
  })
}
