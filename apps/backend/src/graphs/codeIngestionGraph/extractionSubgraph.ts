import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
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

const extractionSubgraph = new StateGraph(ExtractionStateAnnotation, {
  output: ExtractionOutputAnnotation,
})
  .addNode("extractKind", extractKind)
  .addNode("identifyAPIClients", identifyAPIClients) // use repo explorer
  .addNode("identifyAPIs", identifyAPIs) // use repo explorer
  .addNode("identifyDatabases", identifyDatabases) //  use repo explorer
  .addNode("identifyInfrastructure", identifyInfrastructure) //  use repo explorer
  .addNode("identifyStreams", identifyStreams) //  use repo explorer
  .addNode("identifyServiceDependencies", identifyServiceDependencies) //  use repo explorer
  .addNode("identifyLibraries", identifyLibraries) //  use repo explorer
  .addNode("identifyPatterns", identifyPatterns) //  use repo explorer
  .addNode("extractInstructionUnits", extractInstructionUnits)
  .addEdge(START, "extractKind")
  .addEdge("extractKind", "identifyAPIClients")
  .addEdge("extractKind", "identifyAPIs")
  .addEdge("extractKind", "identifyDatabases")
  .addEdge("extractKind", "identifyInfrastructure")
  .addEdge("extractKind", "identifyStreams")
  .addEdge("extractKind", "identifyServiceDependencies")
  .addEdge("extractKind", "identifyLibraries")
  .addEdge("extractKind", "identifyPatterns")
  .addEdge("extractKind", "extractInstructionUnits")
  .addEdge("identifyAPIClients", END)
  .addEdge("identifyAPIs", END)
  .addEdge("identifyDatabases", END)
  .addEdge("identifyInfrastructure", END)
  .addEdge("identifyStreams", END)
  .addEdge("identifyServiceDependencies", END)
  .addEdge("identifyLibraries", END)
  .addEdge("identifyPatterns", END)
  .addEdge("extractInstructionUnits", END)
  .compile()

export { extractionSubgraph }
