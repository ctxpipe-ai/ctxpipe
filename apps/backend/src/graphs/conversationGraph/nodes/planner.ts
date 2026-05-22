import type { RetrievalPlan } from "../../../retrieval/schema/plan.js"
import { RetrievalPlanSchema } from "../../../retrieval/schema/plan.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import type { ConversationGraphState } from "../state.js"

const ID_PATTERN = /\b(claim_|repo_|obj_|ev_)[a-z0-9]+\b/i

/** Query patterns suggesting code→graph anchoring (use code results to anchor graph). */
const IDENTIFIER_PATTERNS = /\b(repo_|obj_|file:|path:|sym:|\.[a-z]{2,4}\b)/i

/** Query patterns suggesting recommendation/validation intent (what should I use, is X allowed). */
const RECOMMENDATION_PATTERNS =
  /\b(what|which|should|recommend|use|allowed|common|standard)\b.*\b(database|db|framework|library|auth|tech)\b/i

/**
 * Structural code intent: the user is asking about relationships or existence in the
 * code graph (who calls, references, definitions, reachability, unused paths) — not
 * merely “what does this file say”. Bias retrieval toward graph steps anchored on code.
 */
const STRUCTURAL_CODE_INTENT_PATTERN =
  /\b(callers?|callees?|call\s*graph|who\s+calls?|what\s+calls|references?\b|find\s+references|reachable|reachab|dead\s+code|orphan(?:ed|s)?|unused|never\s+called|invok(?:e|es|ed|ing)|entry\s*points?|is\s+\S+\s+used|usage\s+of|who\s+uses)\b/i

/** Compact channel reference (avoids full schema YAML in the planner prompt). */
const CHANNEL_CHEAT_SHEET = `
Channels (steps[].type + params):
- hybrid_search — vague/conceptual/docs. params: { "query": "..." }
- code_search — identifiers, paths, implementation, config/env across layers. params: { "query": "..." }
- exact_lookup — query contains claim_|repo_|obj_|ev_ ids. params: { "nodeId": "<id>" }
- graph_anchor + graph_traversal — dependencies, topology, callers/callees, structural code. params: { "anchorFrom": "hybrid"|"code" } (use "code" when query has repo_/file paths/symbols)
- extension_traversal — ADRs, patterns, org-wide concepts. params: { "anchorFrom": "hybrid"|"code" }
- claim_aggregation — standards / "what should I use" / tech choices. params: { "predicates": ["WRITES_TO","READS_FROM","DEPENDS_ON","USES_LIBRARY"] } — include only predicates that fit the question

Example: { "steps":[{"type":"code_search","params":{"query":"authentication library"}},{"type":"claim_aggregation","params":{"predicates":["DEPENDS_ON","USES_LIBRARY"]}}], "depthLimit": 3, "resultLimit": 20 }
`.trim()

/**
 * Cross-artifact configuration intent: settings may live in source, env files, and
 * deployment/infra layers — one lexical hit often misses contradictions. Add a second
 * code_search slice with broad config/deployment terms (not repo-specific filenames).
 */
const CROSS_ARTIFACT_CONFIG_INTENT_PATTERN =
  /\b(environment\s+variable|env\s+vars?|\.env\b|feature\s+flags?|defaults?|configuration|config\s+file|settings?|docker-?compose|compose\.ya?ml|kubernetes|\bk8s\b|\bhelm\b|terraform|deployment|manifest|infrastructure|\binfra\b|inconsistent|inconsistency|mismatch|conflicting\s+(default|value|setting))\b/i

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
    const llmPlan = await planWithLlm(
      query,
      embedding,
      state.currentProjectName,
    )
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
  currentProjectName?: string | null,
): Promise<unknown | null> {
  try {
    const model = getModel("fast", { temperature: 0.1 })
    const projectContext = `Current project name: ${currentProjectName?.trim() || "unknown"}\n\n`

    const prompt = `You are a retrieval planner. Given a user question, choose which retrieval channels to use.

${projectContext}Channels (cheat sheet):
${CHANNEL_CHEAT_SHEET}

Guidelines:
- claim_aggregation: for "what should I use", "what's recommended", "what's common" — use when query asks about tech choices (database, library, framework, auth). Params: { "predicates": ["WRITES_TO","READS_FROM","DEPENDS_ON","USES_LIBRARY"] } — pick predicates that match the question
- graph_anchor + graph_traversal: for dependency/impact/topology questions; anchorFrom "hybrid" when embedding exists, "code" when query suggests code/repo lookups. For structural code questions (callers, references, reachability, usage of a symbol), include graph_anchor + graph_traversal with anchorFrom "code" plus code_search.
- extension_traversal: for concept/topic discovery, ADRs, patterns; use for recommendation/validation queries (should I use X, is X allowed)
- hybrid_search: for vague/conceptual questions, documentation, concept discovery
- code_search: for identifiers, file paths, symbol names, implementation details. When the query may involve configuration or defaults spanning multiple files or deployment layers, include an extra code_search with varied sub-queries (e.g. query + "configuration deployment environment defaults") so different defining locations surface.
- exact_lookup: when query contains claim_, repo_, obj_, ev_ IDs

Output a JSON object: { "steps": [...], "depthLimit": 3, "resultLimit": 20 }
Each step: { "type": "hybrid_search"|"code_search"|"exact_lookup"|"graph_anchor"|"graph_traversal"|"extension_traversal"|"claim_aggregation", "params": { ... } }
For claim_aggregation params: { "predicates": ["WRITES_TO","READS_FROM","DEPENDS_ON","USES_LIBRARY"] } — select predicates relevant to the question
For graph_anchor/graph_traversal params: { "anchorFrom": "hybrid"|"code" }
For hybrid_search/code_search params: { "query": "..." }

User question: "${query}"
Embedding available: ${embedding ? "yes" : "no"}

Respond with ONLY valid JSON, no markdown.`

    const response = await model.invoke(prompt, {
      maxTokens: 200,
    })
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

  if (RECOMMENDATION_PATTERNS.test(query)) {
    steps.push({
      type: "claim_aggregation",
      params: {
        predicates: ["WRITES_TO", "READS_FROM", "DEPENDS_ON", "USES_LIBRARY"],
      },
    })
    if (embedding) {
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

  if (STRUCTURAL_CODE_INTENT_PATTERN.test(query)) {
    const hasGraphAnchor = steps.some((s) => s.type === "graph_anchor")
    if (!hasGraphAnchor && steps.length <= 8) {
      steps.push({
        type: "graph_anchor",
        params: { anchorFrom: "code" },
      })
      steps.push({
        type: "graph_traversal",
        params: { anchorFrom: "code" },
      })
    }
  }

  if (CROSS_ARTIFACT_CONFIG_INTENT_PATTERN.test(query) && steps.length < 10) {
    steps.push({
      type: "code_search",
      params: {
        query: `${query} configuration deployment environment defaults`,
      },
    })
  }

  return RetrievalPlanSchema.parse({
    steps,
    depthLimit: 3,
    resultLimit: 20,
  })
}
