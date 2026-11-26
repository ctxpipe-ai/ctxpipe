import { z } from "zod"

import type { CallWorkspace } from "./call-workspace.js"
import { McpToolError } from "./tool-errors.js"

/*
 * Main-era knowledge on the knowledge plane (CTX-1715). The old stack serves
 * the main-era knowledge of a Workspace from Postgres, as legacy overlay
 * units that the Workspace repository does not hold (ADR-053). The knowledge
 * plane projects only the Workspace repository, so it does not serve them.
 * When the plane serves a Workspace that has such units, the knowledge tools
 * say so, with the action that puts the knowledge into the repository.
 */

/** A Workspace whose main-era knowledge the response does not include. */
const knowledgeNoticeSchema = z.object({
  workspace: z.string(),
  files: z
    .number()
    .int()
    .describe("Knowledge files from before Workspaces that it does not hold."),
  message: z.string(),
})
export type KnowledgeNotice = z.infer<typeof knowledgeNoticeSchema>

export const knowledgeNoticesSchema = z
  .array(knowledgeNoticeSchema)
  .optional()
  .describe(
    "Workspaces with knowledge from before Workspaces that the response does not include, and the action that adds it.",
  )

/** Why the knowledge is missing, and what an owner or admin does about it. */
function legacyKnowledgeMessage(
  workspace: Pick<CallWorkspace, "slug" | "legacyKnowledgeFiles">,
): string {
  const files = workspace.legacyKnowledgeFiles
  return `Workspace "${workspace.slug}" has ${files} knowledge ${files === 1 ? "file" : "files"} from before Workspaces that ${files === 1 ? "is" : "are"} not in its repository, so ctxpipe does not serve ${files === 1 ? "it" : "them"}. An owner or admin of the org can add ${files === 1 ? "it" : "them"}: merge the format upgrade if the Workspace has one open, then start the re-ingestion (Workspace settings, Upgrades).`
}

/**
 * The notices of the Workspaces that the knowledge plane serves
 * (`planeHeads`) and that have main-era knowledge. The old stack serves
 * that knowledge, so a Workspace that it serves gets no notice.
 */
export function legacyKnowledgeNotices(
  workspaces: readonly Pick<
    CallWorkspace,
    "id" | "slug" | "legacyKnowledgeFiles"
  >[],
  planeHeads: ReadonlyMap<string, unknown>,
): KnowledgeNotice[] {
  return workspaces.flatMap((workspace) =>
    planeHeads.has(workspace.id) && workspace.legacyKnowledgeFiles > 0
      ? [
          {
            workspace: workspace.slug,
            files: workspace.legacyKnowledgeFiles,
            message: legacyKnowledgeMessage(workspace),
          },
        ]
      : [],
  )
}

/**
 * `error` with the message of each notice after its own message: a ref or a
 * folder that the plane does not find can be main-era knowledge. With no
 * notice, `error` itself.
 */
export function withNotices(
  error: McpToolError,
  notices: readonly KnowledgeNotice[],
): McpToolError {
  if (notices.length === 0) return error
  return new McpToolError(
    error.code,
    [error.message, ...notices.map((notice) => notice.message)].join(" "),
    { cause: error },
  )
}
