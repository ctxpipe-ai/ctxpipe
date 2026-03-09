import { z } from "zod/v3"

export const RetrievalStepSchema = z.object({
  type: z.enum([
    "hybrid_search",
    "code_search",
    "exact_lookup",
    "graph_anchor",
    "graph_traversal",
  ]),
  params: z.record(z.unknown()),
})

export const RetrievalPlanSchema = z.object({
  steps: z.array(RetrievalStepSchema).max(10),
  depthLimit: z.number().min(1).max(5).default(3),
  resultLimit: z.number().min(1).max(50).default(20),
})

export type RetrievalStep = z.infer<typeof RetrievalStepSchema>
export type RetrievalPlan = z.infer<typeof RetrievalPlanSchema>
