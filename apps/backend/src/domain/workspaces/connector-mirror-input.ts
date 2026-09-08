import { z } from "zod"
import {
  gitFileChangeSchema,
  repositoryFilePathSchema,
} from "../../services/git/file-change.js"
import { gitObjectIdSchema } from "./revision.js"

export const connectorMirrorSourceSchema = z
  .object({
    provider: z.enum(["linear", "notion", "slack", "confluence"]),
    connectionId: z.string().min(1),
    repositoryId: z.string().min(1),
    configBlobSha: gitObjectIdSchema.nullable(),
  })
  .strict()
export type ConnectorMirrorSource = z.infer<typeof connectorMirrorSourceSchema>

export const connectorMirrorContentSchema = z
  .object({
    mirror: connectorMirrorSourceSchema,
    files: z.array(gitFileChangeSchema),
    deletePaths: z.array(repositoryFilePathSchema),
  })
  .strict()
  .refine(
    (input) =>
      [...input.files.map((file) => file.path), ...input.deletePaths].every(
        (path) =>
          path.startsWith(`${input.mirror.provider}/`) &&
          path !== `${input.mirror.provider}/config.yaml`,
      ),
    "A mirror may only change content under its managed provider root",
  )
  .refine(
    (input) =>
      new Set([...input.files.map((file) => file.path), ...input.deletePaths])
        .size ===
      input.files.length + input.deletePaths.length,
    "Each mirror path must have exactly one operation",
  )
