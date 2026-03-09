import { getModel } from "../../../config/models.js"
import { getYamlSchemaForLlm } from "../../../retrieval/index.js"
import { RetrievalPlanSchema } from "../../../retrieval/schema/plan.js"
import type { RetrievalPlan } from "../../../retrieval/schema/plan.js"
import type { ConversationGraphState } from "../state.js"

const ID_PATTERN = /\b(claim_|repo_|obj_|ev_)[a-z0-9]+\b/i

/** Query patterns suggesting code→graph anchoring (use code results to anchor graph). */
const IDENTIFIER_PATTERNS = /\b(repo_|obj_|file:|path:|sym:|\.[a-z]{2,4}\b)/i

/**
 * Intent-aware planner: tries LLM to choose channel mix, falls back to heuristic.
 * Channel selection: graph-heavy for dependencies, semantic-heavy for conceptual,
 * code-search-heavy for identifiers, mixed for impact analysis.
 */
export async function plannerNode(
  state: ConversationGraphState,
): Promise<Partial<ConversationGraphState>> {
  const { query, embedding } = state
  if (!query) return {}

  let plan: RetrievalPlan

  try {
    const llmPlan = await planWithLlm(query, embedding)
    if (llmPlan) {
      plan = RetrievalPlanSchema.parse(llmPlan)
    } else {
      plan = heuristicPlan(query, embedding)
    }
  } catch {
    plan = heuristicPlan(query, embedding)
  }

  return { plan }
}

async function planWithLlm(
  query: string,
  embedding: number[] | undefined,
): Promise<unknown | null> {
  try {
    const model = getModel("fast")
    const schemaYaml = getYamlSchemaForLlm()

    const prompt = `You are a retrieval planner. Given a user question, choose which retrieval channels to use.

Schema (YAML):
${schemaYaml}

Guidelines:
- graph_anchor + graph_traversal: for dependency/impact/topology questions; anchorFrom "hybrid" when embedding exists, "code" when query suggests code/repo lookups
- extension_traversal: for concept/topic discovery, weak extension layer (RELATES_TO, ABOUT); use when query is conceptual or asks about topics/capabilities
- hybrid_search: for vague/conceptual questions, documentation, concept discovery
- code_search: for identifiers, file paths, symbol names, implementation details
- exact_lookup: when query contains claim_, repo_, obj_, ev_ IDs

Output a JSON object: { "steps": [...], "depthLimit": 3, "resultLimit": 20 }
Each step: { "type": "hybrid_search"|"code_search"|"exact_lookup"|"graph_anchor"|"graph_traversal"|"extension_traversal", "params": { ... } }
For graph_anchor/graph_traversal params: { "anchorFrom": "hybrid"|"code" }
For hybrid_search/code_search params: { "query": "..." }

User question: "${query}"
Embedding available: ${embedding ? "yes" : "no"}

Respond with ONLY valid JSON, no markdown.`

    const response = await model.invoke(prompt)
    const content =
      typeof response.content === "string"
        ? response.content
        : Array.isArray(response.content)
          ? (response.content as { type?: string; text?: string }[])
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("")
          : ""

    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    return JSON.parse(jsonMatch[0]) as unknown
  } catch {
    return null
  }
}

function heuristicPlan(
  query: string,
  embedding: number[] | undefined,
): RetrievalPlan {
  const steps: RetrievalPlan["steps"] = []

  if (embedding) {
    steps.push({ type: "hybrid_search", params: { query } })
  }
  steps.push({ type: "code_search", params: { query } })

  if (embedding) {
    const useCodeAnchor =
      IDENTIFIER_PATTERNS.test(query) || query.includes("repo_")
    steps.push({
      type: "graph_anchor",
      params: { anchorFrom: useCodeAnchor ? "code" : "hybrid" },
    })
    steps.push({
      type: "graph_traversal",
      params: { anchorFrom: useCodeAnchor ? "code" : "hybrid" },
    })
    const conceptualPatterns = /\b(concept|topic|capability|relates?|about)\b/i
    if (conceptualPatterns.test(query)) {
      steps.push({
        type: "extension_traversal",
        params: { anchorFrom: "hybrid" },
      })
    }
  }

  const idMatch = query.match(ID_PATTERN)
  if (idMatch) {
    steps.push({
      type: "exact_lookup",
      params: { nodeId: idMatch[0] },
    })
  }

  return RetrievalPlanSchema.parse({
    steps,
    depthLimit: 3,
    resultLimit: 20,
  })
}
