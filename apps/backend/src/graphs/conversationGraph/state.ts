import { MessagesZodState } from "@langchain/langgraph"
import { z } from "zod/v3"
import { CandidateSchema } from "../../retrieval/schema/candidate.js"
import { RetrievalPlanSchema } from "../../retrieval/schema/plan.js"

export const ConversationGraphStateSchema = MessagesZodState.extend({
  conversationName: z.string().optional(),
  query: z.string().optional(),
  embedding: z.array(z.number()).optional(),
  plan: RetrievalPlanSchema.optional(),
  orgId: z.string().optional(),
  orgSlug: z.string().optional(),
  objectIds: z.array(z.string()).default([]),
  claimIds: z.array(z.string()).default([]),
  hybridResults: z.array(z.record(z.unknown())).default([]),
  codeResults: z.array(z.record(z.unknown())).default([]),
  graphNodes: z.array(z.record(z.unknown())).default([]),
  traversalResults: z.array(z.record(z.unknown())).default([]),
  candidates: z.array(CandidateSchema).default([]),
  hydratedClaims: z.array(z.record(z.unknown())).default([]),
  claimAggregationResults: z
    .array(
      z.object({
        objectId: z.string(),
        predicate: z.string(),
        subjectCount: z.number(),
      }),
    )
    .default([]),
  retrievalContext: z.string().optional(),
})

export type ConversationGraphState = z.infer<typeof ConversationGraphStateSchema>
