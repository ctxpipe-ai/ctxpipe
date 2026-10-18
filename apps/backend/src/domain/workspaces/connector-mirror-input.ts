import { z } from "zod"
import { sourceTargetSchema } from "../../models/workspace-source-state.js"
import {
  gitFileChangeSchema,
  repositoryFilePathSchema,
} from "../../services/git/file-change.js"
import { unsafeMirrorPath } from "../workspace-sources/mirror-path.js"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"
import { gitObjectIdSchema } from "./revision.js"

/** A connector bound to the target repository whose scope is `<provider>/config.yaml`. */
const configuredMirrorSourceSchema = z
  .object({
    provider: z.enum(["linear", "notion", "slack", "confluence", "pagerduty"]),
    connectionId: z.string().min(1),
    repositoryId: z.string().min(1),
    configBlobSha: gitObjectIdSchema.nullable(),
  })
  .strict()
export type ConfiguredConnectorMirrorSource = z.infer<
  typeof configuredMirrorSourceSchema
>

/** GitHub pull requests have no binding: the Workspace's link to `gitUrl` is the scope. */
const githubMirrorSourceSchema = z
  .object({ provider: z.literal("github"), gitUrl: linkedRepositoryUrlSchema })
  .strict()

const workspaceSourcesProviderSchema = z.enum([
  "github",
  "linear",
  "notion",
  "slack",
  "confluence",
  "pagerduty",
  "buildkite",
])

/**
 * A Workspace source sync (ADR-050): the scope is `.ctxpipe/sources.yaml` of
 * the target Workspace. A change of that file discards the write. A cleanup
 * of removed sources has `removedTargets` instead: it is discarded only when
 * the sources at the head have one of these targets again.
 */
const workspaceSourcesMirrorSchema = z.union([
  z
    .object({
      provider: workspaceSourcesProviderSchema,
      connectionId: z.string().min(1),
      /** The sources fence id (`sourcesFenceAt`); the name is from the YAML-only fence. */
      sourcesBlobSha: gitObjectIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      provider: workspaceSourcesProviderSchema,
      connectionId: z.string().min(1),
      removedTargets: z.array(sourceTargetSchema).min(1),
    })
    .strict(),
])
export type WorkspaceSourcesMirrorSource = z.infer<
  typeof workspaceSourcesMirrorSchema
>

export const connectorMirrorSourceSchema = z.union([
  configuredMirrorSourceSchema,
  githubMirrorSourceSchema,
  workspaceSourcesMirrorSchema,
])
export type ConnectorMirrorSource = z.infer<typeof connectorMirrorSourceSchema>

export const connectorMirrorContentSchema = z
  .object({
    mirror: connectorMirrorSourceSchema,
    files: z.array(gitFileChangeSchema),
    deletePaths: z.array(repositoryFilePathSchema),
  })
  .strict()
  .refine(
    // A delete names a path that exists in the tree and cannot plant content,
    // so it needs no name rules beyond `repositoryFilePathSchema`.
    (input) =>
      [...input.files.map((file) => file.path), ...input.deletePaths].every(
        (path) =>
          path.startsWith(`${input.mirror.provider}/`) &&
          path !== `${input.mirror.provider}/config.yaml`,
      ) && input.files.every((file) => unsafeMirrorPath(file.path) === null),
    "A mirror may only change safe paths under its managed provider root",
  )
  .refine(
    (input) =>
      new Set([...input.files.map((file) => file.path), ...input.deletePaths])
        .size ===
      input.files.length + input.deletePaths.length,
    "Each mirror path must have exactly one operation",
  )
