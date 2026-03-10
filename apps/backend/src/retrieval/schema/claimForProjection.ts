import { z } from "zod/v3"

/** Claim payload for graph projection - all data from previous nodes */
export const ClaimForProjectionSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  objectId: z.string(),
  subjectType: z.string(),
  objectType: z.string(),
  predicate: z.string(),
  aggregatedConfidence: z.number(),
  sourceCount: z.number(),
  lastObservedAt: z.string(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
})

export type ClaimForProjection = z.infer<typeof ClaimForProjectionSchema>
