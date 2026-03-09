import { END, START, StateGraph } from "@langchain/langgraph"
import { z } from "zod/v3"
import { embed } from "./nodes/embed.js"
import { extract } from "./nodes/extract.js"
import { project } from "./nodes/project.js"
import { reindex } from "./nodes/reindex.js"

const CodeIngestionState = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  fromHash: z.string().optional(),
  targetHash: z.string().min(1),
  indexedAt: z.string().optional(),
  objectIds: z.array(z.string()).optional(),
  claimIds: z.array(z.string()).optional(),
})

const graph = new StateGraph(CodeIngestionState)
  .addNode("reindex", reindex)
  .addNode("extract", extract)
  .addNode("embed", embed)
  .addNode("project", project)
  .addEdge(START, "reindex")
  .addEdge("reindex", "extract")
  .addEdge("extract", "embed")
  .addEdge("embed", "project")
  .addEdge("project", END)
  .compile()

export { graph }
