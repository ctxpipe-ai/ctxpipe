import { END, Send, START, StateGraph } from "@langchain/langgraph"
import "@langchain/langgraph/zod"
import type { CodeIngestionState } from "./schemas.js"
import { extractionSubgraph } from "./extractionSubgraph.js"
import { identifyRoots } from "./nodes/identifyRoots.js"
import { reindex } from "./nodes/reindex.js"
import { CodeIngestionStateSchema } from "./schemas.js"

function fanOutRoots(state: CodeIngestionState): Send[] {
  const roots = state.roots ?? []
  console.log("fanning out roots", roots)
  return roots.map(
    (root) => new Send("extractForRoot", { ...state, roots: [root] }),
  )
}

const graph = new StateGraph(CodeIngestionStateSchema)
  .addNode("reindex", reindex)
  .addNode("identifyRoots", identifyRoots)
  .addNode("extractForRoot", extractionSubgraph)
  .addEdge(START, "reindex")
  .addEdge("reindex", "identifyRoots")
  .addConditionalEdges("identifyRoots", fanOutRoots)
  .addEdge("extractForRoot", END)
  .compile()

export { graph }
