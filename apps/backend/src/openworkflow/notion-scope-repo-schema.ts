import { z } from "zod"

export const parsedNotionRepoScopeSchema = z.object({
  resources: z.array(
    z.object({
      externalId: z.string().min(1),
      type: z.enum(["page", "database"]),
      title: z.string().min(1),
    }),
  ),
})

export type ParsedNotionRepoScopeInput = z.infer<
  typeof parsedNotionRepoScopeSchema
>
