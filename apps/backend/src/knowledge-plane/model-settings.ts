import { log } from "../observability/logger.js"
import { openRouterSettings } from "../retrieval/services/modelProvider.js"

/**
 * Logs one error when the model settings cannot reach Jev and the plane
 * embeddings. These models are only on OpenRouter (ADR-068 decisions 5 and
 * 7), so an install with `MODEL_PROVIDER` `bedrock` or `azure`, or with no
 * key, cannot project a Workspace. Its orgs keep the old stack: a
 * Workspace is served from the plane only when it is ready. The worker
 * calls this at start, because the worker runs the projections.
 * Returns true when the settings reach OpenRouter.
 */
export function checkKnowledgePlaneModelSettings(): boolean {
  if (openRouterSettings()) return true
  log.error({
    step: "knowledge_plane.model_settings",
    message:
      "The knowledge plane needs MODEL_PROVIDER openrouter or openai-like, an OpenRouter MODEL_PROVIDER_URL, and MODEL_PROVIDER_API_KEY. Without them, no Workspace becomes ready on the plane, and the old knowledge stack answers.",
  })
  return false
}
