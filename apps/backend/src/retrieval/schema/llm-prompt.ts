import YAML from "yaml"
import { ClaimStatus, ExtractionMethod, SourceType } from "./claims.js"
import { CoreNodeType, CoreRelType } from "./core.js"
import { ExtensionNodeType, ExtensionRelType } from "./extension.js"
import { getAllowedConnections } from "./allowedConnections.js"

/**
 * Returns a simplified YAML schema for LLM retrieval planning.
 * This is for prompting only — Zod schemas remain canonical.
 */
export function getYamlSchemaForLlm(): string {
  const { core: coreConnections, extension: extensionConnections } =
    getAllowedConnections()

  const simplified = {
    retrievalPlan: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              enum: [
                "hybrid_search",
                "code_search",
                "exact_lookup",
                "graph_anchor",
                "graph_traversal",
                "extension_traversal",
                "claim_aggregation",
              ],
            },
            params: { type: "object" },
          },
          required: ["type", "params"],
        },
      },
      depthLimit: { type: "number", default: 3, minimum: 1, maximum: 5 },
      resultLimit: { type: "number", default: 20, minimum: 1, maximum: 50 },
    },
    stepTypes: [
      "hybrid_search",
      "code_search",
      "exact_lookup",
      "graph_anchor",
      "graph_traversal",
      "extension_traversal",
      "claim_aggregation",
    ],
    claim: {
      fields: [
        "id",
        "subjectId",
        "predicate",
        "objectId",
        "status",
        "validFrom",
        "validTo",
        "firstObservedAt",
        "lastObservedAt",
        "aggregatedConfidence",
      ],
      statusValues: ClaimStatus.options,
    },
    evidence: {
      fields: [
        "id",
        "claimId",
        "sourceType",
        "sourceId",
        "sourceUrl",
        "extractionMethod",
        "confidence",
        "observedAt",
        "validFrom",
        "validTo",
        "provenance",
      ],
      sourceTypes: SourceType.options,
      extractionMethods: ExtractionMethod.options,
    },
    coreNodeTypes: CoreNodeType.options,
    coreRelTypes: CoreRelType.options,
    extensionNodeTypes: ExtensionNodeType.options,
    extensionRelTypes: ExtensionRelType.options,
    allowedConnections: {
      core: coreConnections,
      extension: extensionConnections,
    },
  }

  return YAML.stringify(simplified, { lineWidth: 0 })
}
