import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { deduplicateAndStore } from "./nodes/deduplicateAndStore.js"
import { embed } from "./nodes/embed.js"
import { extractType } from "./nodes/extractType.js"
import { identifyAPIs } from "./nodes/identifyAPIs.js"
import { identifyDatabases } from "./nodes/identifyDatabases.js"
import { project } from "./nodes/project.js"
import type { ExtractedClaim, ExtractedObject } from "./schemas.js"

const arrayReducer = <T>(left: T[], right: T | T[]): T[] =>
  left.concat(Array.isArray(right) ? right : [right])

const ExtractionStateAnnotation = Annotation.Root({
  repositoryId: Annotation<string>(),
  orgId: Annotation<string>(),
  fromHash: Annotation<string | undefined>(),
  targetHash: Annotation<string>(),
  indexedAt: Annotation<string | undefined>(),
  roots: Annotation<string[]>({
    reducer: (left, right) =>
      (Array.isArray(right) ? right : right ? [right] : left) ?? left,
    default: () => [],
  }),
  extractedObjects: Annotation<ExtractedObject[]>({
    reducer: arrayReducer,
    default: () => [],
  }),
  extractedClaims: Annotation<ExtractedClaim[]>({
    reducer: arrayReducer,
    default: () => [],
  }),
  objectIds: Annotation<string[]>({
    reducer: (left, right) =>
      (Array.isArray(right) ? right : right ? [right] : left) ?? left,
    default: () => [],
  }),
  claimIds: Annotation<string[]>({
    reducer: (left, right) =>
      (Array.isArray(right) ? right : right ? [right] : left) ?? left,
    default: () => [],
  }),
})

const extractionSubgraph = new StateGraph(ExtractionStateAnnotation, {
  output: Annotation.Root({}),
})
  .addNode("extractType", extractType)
  .addNode("identifyAPIs", identifyAPIs)
  .addNode("identifyDatabases", identifyDatabases)
  .addNode("deduplicateAndStore", deduplicateAndStore)
  .addNode("project", project)
  .addNode("embed", embed)
  .addEdge(START, "extractType")
  .addEdge(START, "identifyAPIs")
  .addEdge(START, "identifyDatabases")
  .addEdge(
    ["extractType", "identifyAPIs", "identifyDatabases"],
    "deduplicateAndStore",
  )
  .addEdge("deduplicateAndStore", "project")
  .addEdge("project", "embed")
  .addEdge("embed", END)
  .compile()

export { extractionSubgraph }
