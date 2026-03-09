import { z } from "zod/v3"

export const SourceChannel = z.enum(["graph", "semantic", "code"])
export type SourceChannel = z.infer<typeof SourceChannel>

export const CandidateSchema = z.object({
  id: z.string(),
  sourceChannels: z.array(SourceChannel),
  objectId: z.string().optional(),
  claimId: z.string().optional(),
  score: z.number().optional(),
  payload: z.record(z.unknown()),
  provenance: z.record(z.unknown()).optional(),
})

export type Candidate = z.infer<typeof CandidateSchema>
