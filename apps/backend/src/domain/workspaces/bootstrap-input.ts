import { z } from "zod"

import { repositoryRemoteSchema } from "./revision.js"
import { workspaceRootPathSchema } from "./root-path.js"

/** A write target before its first commit; never a read revision. */
export const unbornBootstrapBindingSchema = z
  .object({
    workspaceId: z.string().min(1),
    generation: z.number().int().positive(),
    remote: repositoryRemoteSchema,
    defaultBranch: z.string().min(1),
    /** Workspace root folder; absent for the repository root. */
    rootPath: workspaceRootPathSchema.optional(),
  })
  .strict()

export type UnbornBootstrapBinding = z.infer<
  typeof unbornBootstrapBindingSchema
>
