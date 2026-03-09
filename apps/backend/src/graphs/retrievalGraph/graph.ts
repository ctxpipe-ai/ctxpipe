import { END, START, StateGraph } from "@langchain/langgraph"
import { z } from "zod/v3"
import { RetrievalPlanSchema } from "../../retrieval/schema/plan.js"
import { executeSteps } from "./nodes/executeSteps.js"

const RetrievalGraphStateSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  query: z.string(),
  embedding: z.array(z.number()).optional(),
  plan: RetrievalPlanSchema,
  objectIds: z.array(z.string()).default([]),
  claimIds: z.array(z.string()).default([]),
  hybridResults: z.array(z.record(z.unknown())).default([]),
  codeResults: z.array(z.record(z.unknown())).default([]),
  graphNodes: z.array(z.record(z.unknown())).default([]),
  traversalResults: z.array(z.record(z.unknown())).default([]),
  hydratedClaims: z.array(z.record(z.unknown())).default([]),
})

const graph = new StateGraph(RetrievalGraphStateSchema)
  .addNode("executeSteps", executeSteps)
  .addEdge(START, "executeSteps")
  .addEdge("executeSteps", END)
  .compile()

export { graph }
export type { RetrievalGraphState } from "./nodes/executeSteps.js"
