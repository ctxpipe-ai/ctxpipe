import { END, START, StateGraph } from "@langchain/langgraph"
import { z } from "zod/v3"
import { reindex } from "./nodes/reindex.js"

const CodeIngestionState = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  fromHash: z.string().optional(),
  sourceBranch: z.string().optional(),
  targetHash: z.string().min(1),
  indexedAt: z.string().optional(),
})

const graph = new StateGraph(CodeIngestionState)
  .addNode("reindex", reindex)
  .addEdge(START, "reindex")
  .addEdge("reindex", END)
  .compile()

export { graph }
