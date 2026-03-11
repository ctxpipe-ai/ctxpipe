import { z } from "zod/v3"

export const CoreNodeType = z.enum([
  "Service",
  "API",
  "Stream",
  "Database",
  "Infrastructure",
  "Library",
  "Pattern",
])

export const CoreRelType = z.enum([
  "DEPENDS_ON",
  "EXPOSES_API",
  "CONSUMES_API",
  "PRODUCES_TO",
  "CONSUMES_FROM",
  "READS_FROM",
  "WRITES_TO",
  "USES_LIBRARY",
  "IMPLEMENTS_PATTERN",
  "IMPLEMENTED_IN",
  "RUNS_ON",
])

export const CoreNodeSchema = z.object({
  id: z.string(),
  kind: CoreNodeType,
  orgId: z.string(),
  name: z.string().optional(),
  summary: z.string().max(500).optional(),
})

export type CoreNodeType = z.infer<typeof CoreNodeType>
export type CoreRelType = z.infer<typeof CoreRelType>
export type CoreNode = z.infer<typeof CoreNodeSchema>
