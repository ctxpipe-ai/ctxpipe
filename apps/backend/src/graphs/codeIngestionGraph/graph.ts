import { END, Send, START, StateGraph } from "@langchain/langgraph"
import "@langchain/langgraph/zod"
import { getLogger } from "../../observability/logger.js"
import { extractionSubgraph } from "./extractionSubgraph.js"
import { identifyRoots } from "./nodes/identifyRoots.js"
import { reindex } from "./nodes/reindex.js"
import { retractStaleEvidence } from "./nodes/retractStaleEvidence.js"
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
  .addNode("reindex", reindex)
  .addNode("retractStaleEvidence", retractStaleEvidence)
  .addNode("identifyRoots", identifyRoots)
  .addNode("extractForRoot", extractionSubgraph)
  .addEdge(START, "reindex")
  .addEdge("reindex", "retractStaleEvidence")
  .addEdge("retractStaleEvidence", "identifyRoots")
  .addConditionalEdges("identifyRoots", fanOutRoots)
  .addEdge("extractForRoot", END)
  .compile()

export { graph }
