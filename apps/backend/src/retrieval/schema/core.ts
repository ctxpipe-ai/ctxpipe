import { z } from "zod/v3"

export const CoreNodeType = z.enum([
  "Service",
  "App",
  "API",
  "Operation",
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
  "HAS_OPERATION",
  "PRODUCES_TO",
  "CONSUMES_FROM",
  "READS_FROM",
  "WRITES_TO",
  "USES_LIBRARY",
  "IMPLEMENTS_PATTERN",
  "IMPLEMENTED_IN",
  "RUNS_ON",
  "HAS_INSTRUCTION",
  "FOLLOWS",
])

export type CoreNodeType = z.infer<typeof CoreNodeType>
export type CoreRelType = z.infer<typeof CoreRelType>
