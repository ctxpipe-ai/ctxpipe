import { END, Send, START, StateGraph } from "@langchain/langgraph"
import "@langchain/langgraph/zod"
import { getLogger } from "../../observability/logger.js"
import { extractionSubgraph } from "./extractionSubgraph.js"
import { deduplicateAndStore } from "./nodes/deduplicateAndStore.js"
import { embed } from "./nodes/embed.js"
import { identifyRoots } from "./nodes/identifyRoots.js"
import { project } from "./nodes/project.js"
import type { CodeIngestionState } from "./schemas.js"
import { CodeIngestionStateSchema } from "./schemas.js"

function fanOutRoots(state: CodeIngestionState): Send[] {
  const roots = state.roots ?? []
  const logger = getLogger()
  logger.set({ roots })
  logger.info("fanning out roots")
  return roots.map(
    (root) => new Send("extractForRoot", { ...state, roots: [root] }),
  )
}

const graph = new StateGraph(CodeIngestionStateSchema)
  .addNode("identifyRoots", identifyRoots)
  .addNode("extractForRoot", extractionSubgraph)
  .addNode("deduplicateAndStore", deduplicateAndStore)
  .addNode("project", project)
  .addNode("embed", embed)
  .addEdge(START, "identifyRoots")
  .addConditionalEdges("identifyRoots", fanOutRoots)
  .addEdge("extractForRoot", "deduplicateAndStore")
  .addEdge("deduplicateAndStore", "project")
  .addEdge("project", "embed")
  .addEdge("embed", END)
  .compile()

export { graph }
