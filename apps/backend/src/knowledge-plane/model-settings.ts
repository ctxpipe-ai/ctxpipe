import { knowledgePlaneSettingsProblem } from "../../../../packages/aws-cdk/src/internal/knowledge-plane-settings.js"
import { log } from "../observability/logger.js"

/**
 * True when the model settings can serve the plane: the calls of Jev, the
 * plane embeddings and the vision model go to OpenRouter, with a key, and
 * an allowlist allows the provider of Jev. These models are only on
 * OpenRouter (ADR-068 decisions 5 and 7). The rule is
 * `knowledgePlaneSettingsProblem`, which the deployments of
 * `@ctxpipe/aws-cdk` and Compose also pass (the env contract test). The
 * projection and the start log of the worker use it.
 */
export function planeModelsReachable(): boolean {
  return knowledgePlaneSettingsProblem(process.env) === undefined
}

/**
 * Logs one error at the start of the worker when the model settings cannot
 * serve the plane. No Workspace of such an install becomes ready (the
 * projection checks the same settings), so its orgs keep the old stack.
 */
export function checkKnowledgePlaneModelSettings(): void {
  const problem = knowledgePlaneSettingsProblem(process.env)
  if (!problem) return
  log.error({
    step: "knowledge_plane.model_settings",
    problem,
    message:
      "The knowledge plane needs MODEL_PROVIDER openrouter, or openai-like with a MODEL_PROVIDER_URL on openrouter.ai, and MODEL_PROVIDER_API_KEY. A MODEL_PROVIDER_ALLOWLIST must include typesafe, the provider of the decision model. Without them, no Workspace becomes ready on the plane, and the old knowledge stack answers.",
  })
}
