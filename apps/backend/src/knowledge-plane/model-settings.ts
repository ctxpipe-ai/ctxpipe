import { log } from "../observability/logger.js"
import { openRouterSettings } from "../retrieval/services/modelProvider.js"
import { isOpenRouterCall } from "../retrieval/services/openRouterProvider.js"

/**
 * Logs one error when the model settings do not send the calls of Jev and
 * the plane embeddings to OpenRouter. These models are only on OpenRouter
 * (ADR-068 decisions 5 and 7). Thus an install with `MODEL_PROVIDER`
 * `bedrock` or `azure`, with an `openai-like` URL of another API, or with
 * no key cannot project a Workspace. Its orgs keep the old stack: a
 * Workspace is served from the plane only when it is ready. The worker
 * calls this at start, because the worker runs the projections.
 */
export function checkKnowledgePlaneModelSettings(): void {
  if (
    openRouterSettings() &&
    isOpenRouterCall(process.env.MODEL_PROVIDER, process.env.MODEL_PROVIDER_URL)
  )
    return
  log.error({
    step: "knowledge_plane.model_settings",
    message:
      "The knowledge plane needs MODEL_PROVIDER openrouter, or openai-like with a MODEL_PROVIDER_URL on openrouter.ai, and MODEL_PROVIDER_API_KEY. Without them, no Workspace becomes ready on the plane, and the old knowledge stack answers.",
  })
}
