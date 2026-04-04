import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { deduplicateAndStore } from "./nodes/deduplicateAndStore.js"
import { embed } from "./nodes/embed.js"
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
import { project } from "./nodes/project.js"
import type {
  ClaimForProjection,
  ExtractedClaim,
  ExtractedObject,
} from "./schemas.js"

const arrayReducer = <T>(left: T[], right: T | T[]): T[] =>
  left.concat(Array.isArray(right) ? right : [right])

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
  touchedObjectIds: Annotation<string[]>({
    reducer: (left, right) =>
      (Array.isArray(right) ? right : right ? [right] : left) ?? left,
    default: () => [],
  }),
  claimsForProjection: Annotation<ClaimForProjection[]>({
    reducer: arrayReducer,
    default: () => [],
  }),
})

const extractionSubgraph = new StateGraph(ExtractionStateAnnotation, {
  output: Annotation.Root({}),
})
  .addNode("extractKind", extractKind)
  .addNode("identifyAPIClients", identifyAPIClients)
  .addNode("identifyAPIs", identifyAPIs)
  .addNode("identifyDatabases", identifyDatabases)
  .addNode("identifyInfrastructure", identifyInfrastructure)
  .addNode("identifyStreams", identifyStreams)
  .addNode("identifyServiceDependencies", identifyServiceDependencies)
  .addNode("identifyLibraries", identifyLibraries)
  .addNode("identifyPatterns", identifyPatterns)
  .addNode("extractInstructionUnits", extractInstructionUnits)
  .addNode("deduplicateAndStore", deduplicateAndStore)
  .addNode("project", project)
  .addNode("embed", embed)
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
  .addEdge(
    [
      "identifyAPIClients",
      "identifyAPIs",
      "identifyDatabases",
      "identifyInfrastructure",
      "identifyStreams",
      "identifyServiceDependencies",
      "identifyLibraries",
      "identifyPatterns",
      "extractInstructionUnits",
    ],
    "deduplicateAndStore",
  )
  .addEdge("deduplicateAndStore", "project")
  .addEdge("project", "embed")
  .addEdge("embed", END)
  .compile()

export { extractionSubgraph }
