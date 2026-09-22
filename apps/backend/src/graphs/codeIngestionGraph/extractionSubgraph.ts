import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { CONNECTOR_EXTRACTORS } from "./nodes/connectorExtractors.js"
import { extractCodeowners } from "./nodes/extractCodeowners.js"
import { extractDecisions } from "./nodes/extractDecisions.js"
import { extractInstructionUnits } from "./nodes/extractInstructionUnits.js"
import { extractKind } from "./nodes/extractKind.js"
import { identifyAPIClients } from "./nodes/identifyAPIClients.js"
import { identifyAPIs } from "./nodes/identifyAPIs.js"
import { identifyDatabases } from "./nodes/identifyDatabases.js"
import { identifyInfrastructure } from "./nodes/identifyInfrastructure.js"
import { identifyLibraries } from "./nodes/identifyLibraries.js"
import { identifyPatterns } from "./nodes/identifyPatterns.js"
import { identifyServiceDependencies } from "./nodes/identifyServiceDependencies.js"
import { identifyStreams } from "./nodes/identifyStreams.js"
import { linkLocatedPathsNode } from "./nodes/linkLocatedPaths.js"
import type { ExtractedClaim, ExtractedObject } from "./schemas.js"

const arrayReducer = <T>(left: T[], right: T | T[]): T[] =>
  left.concat(Array.isArray(right) ? right : [right])

const extractedObjectsAnnotation = Annotation<ExtractedObject[]>({
  reducer: arrayReducer,
  default: () => [],
})
const extractedClaimsAnnotation = Annotation<ExtractedClaim[]>({
  reducer: arrayReducer,
  default: () => [],
})

const ExtractionStateAnnotation = Annotation.Root({
  repositoryId: Annotation<string>(),
  orgId: Annotation<string>(),
  fromHash: Annotation<string | undefined>(),
  targetHash: Annotation<string>(),
  ingestMode: Annotation<"full" | "partial" | undefined>({
    reducer: (left, right) => (right !== undefined ? right : left),
    default: () => undefined,
  }),
  changedPaths: Annotation<string[] | undefined>({
    reducer: (left, right) => (right !== undefined ? right : left),
    default: () => undefined,
  }),
  deletedPaths: Annotation<string[] | undefined>({
    reducer: (left, right) => (right !== undefined ? right : left),
    default: () => undefined,
  }),
  renames: Annotation<{ from: string; to: string }[] | undefined>({
    reducer: (left, right) => (right !== undefined ? right : left),
    default: () => undefined,
  }),
  indexedAt: Annotation<string | undefined>(),
  roots: Annotation<string[]>({
    reducer: (left, right) =>
      (Array.isArray(right) ? right : right ? [right] : left) ?? left,
    default: () => [],
  }),
  extractedObjects: extractedObjectsAnnotation,
  extractedClaims: extractedClaimsAnnotation,
})

/** Parent `deduplicateAndStore` reads these after parallel `extractForRoot` branches merge. */
const ExtractionOutputAnnotation = Annotation.Root({
  extractedObjects: extractedObjectsAnnotation,
  extractedClaims: extractedClaimsAnnotation,
})

const identifyNodes = [
  ["identifyAPIClients", identifyAPIClients],
  ["identifyAPIs", identifyAPIs],
  ["identifyDatabases", identifyDatabases],
  ["identifyInfrastructure", identifyInfrastructure],
  ["identifyStreams", identifyStreams],
  ["identifyServiceDependencies", identifyServiceDependencies],
  ["identifyLibraries", identifyLibraries],
  ["identifyPatterns", identifyPatterns],
  ["extractInstructionUnits", extractInstructionUnits],
  ["extractDecisions", extractDecisions],
  ["extractCodeowners", extractCodeowners],
] as const

let extractionGraph = new StateGraph(ExtractionStateAnnotation, {
  output: ExtractionOutputAnnotation,
})
  .addNode("extractKind", extractKind)
  .addNode("linkLocatedPaths", linkLocatedPathsNode)
  .addEdge(START, "extractKind")

for (const [name, node] of identifyNodes) {
  extractionGraph = extractionGraph
    .addNode(name, node)
    .addEdge("extractKind", name)
    .addEdge(name, "linkLocatedPaths")
}

for (const extractor of CONNECTOR_EXTRACTORS) {
  const name = extractor.extract.name
  extractionGraph = extractionGraph
    .addNode(name, extractor.extract)
    .addEdge("extractKind", name)
    .addEdge(name, "linkLocatedPaths")
}

const extractionSubgraph = extractionGraph
  .addEdge("linkLocatedPaths", END)
  .compile()

export { extractionSubgraph }
