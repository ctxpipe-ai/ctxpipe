import { z } from "zod"

/** Serialized Git-authoritative scope passed into workflows (Case 1 push path). */
export const parsedRepoScopeSchema = z.object({
  spaces: z.array(
    z.object({
      spaceKey: z.string(),
      selectedPageIds: z.array(z.string()).nullable(),
    }),
  ),
})

export type ParsedRepoScopeWorkflowInput = z.infer<typeof parsedRepoScopeSchema>
