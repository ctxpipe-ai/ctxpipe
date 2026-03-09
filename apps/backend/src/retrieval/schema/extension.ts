import { z } from "zod/v3"

export const ExtensionNodeType = z.enum([
  "Concept",
  "Capability",
  "Topic",
  "Incident",
  "Decision",
])

export const ExtensionRelType = z.enum([
  "RELATES_TO",
  "ABOUT",
  "MENTIONS",
  "ASSOCIATED_WITH",
  "INFLUENCES",
])

export type ExtensionNodeType = z.infer<typeof ExtensionNodeType>
export type ExtensionRelType = z.infer<typeof ExtensionRelType>
