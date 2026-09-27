import { z } from "zod/v3"

/**
 * Extension kinds. Every kind here has at least one extractor that emits it;
 * kinds without an extractor are not declared (ADR-033).
 */
export const ExtensionNodeType = z.enum([
  "Decision",
  "InstructionUnit",
  "Skill",
  "PullRequest",
  "File",
  "Issue",
  "Team",
  "Thread",
])

/**
 * Extension predicates, grouped by relation family (ADR-033):
 * - provenance: DECLARED_IN, MEMBER_OF_PRIMARY
 * - containment: PART_OF
 * - change: ADDED, MODIFIED, REMOVED, RENAMED, TARGETS
 * - reference: REFERENCES, MENTIONS, SUPERSEDES
 * - ownership: OWNS
 * - cause: INFLUENCES
 */
export const ExtensionRelType = z.enum([
  "MENTIONS",
  "INFLUENCES",
  "MEMBER_OF_PRIMARY",
  "PART_OF",
  "DECLARED_IN",
  "TARGETS",
  "ADDED",
  "MODIFIED",
  "REMOVED",
  "RENAMED",
  "REFERENCES",
  "OWNS",
  "SUPERSEDES",
])

export type ExtensionNodeType = z.infer<typeof ExtensionNodeType>
export type ExtensionRelType = z.infer<typeof ExtensionRelType>
