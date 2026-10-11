import type { Env } from "../../config/env.js"
import { listOrgConnections } from "../../models/org-connections.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { readFileAtGitSha } from "../../services/git/clone-tree.js"
import type { WorkspaceRevision } from "../workspaces/revision.js"
import { SOURCE_ADAPTERS, type SourceAdapter } from "./adapter.js"
import { planSourceRows, type SourceAccessCheck } from "./projection-plan.js"
import { SOURCES_FILE_PATH, type SourceProvider } from "./sources-file.js"

/**
 * Project `.ctxpipe/sources.yaml` at one Workspace revision into
 * `workspace_sources`. Running it again for the same revision changes nothing.
 */
export async function projectWorkspaceSources(input: {
  orgId: string
  revision: WorkspaceRevision
  token?: string
  env: Env
  adapters?: Partial<Record<SourceProvider, SourceAdapter>>
}) {
  const adapters = input.adapters ?? SOURCE_ADAPTERS
  const file = await readFileAtGitSha({
    url: input.revision.remote.url,
    sha: input.revision.sha,
    path: SOURCES_FILE_PATH,
    token: input.token,
  })
  const text =
    file.kind === "bytes" ? Buffer.from(file.bytes).toString("utf8") : null
  const connections = new Map(
    (await listOrgConnections(input.orgId)).map((connection) => [
      connection.id,
      { id: connection.id, type: connection.type },
    ]),
  )
  const checkAccess: SourceAccessCheck = async (entry) => {
    const adapter = adapters[entry.provider]
    if (!adapter?.checkAccess) return null
    return adapter.checkAccess({
      orgId: input.orgId,
      connectionId: entry.connectionId,
      scope: entry.scope,
      env: input.env,
    })
  }
  const rows = await planSourceRows({ text, connections, checkAccess })
  return replaceWorkspaceSourceRows({
    orgId: input.orgId,
    workspaceId: input.revision.workspaceId,
    revision: input.revision.sha,
    rows,
  })
}
