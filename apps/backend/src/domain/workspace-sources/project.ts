import type { Env } from "../../config/env.js"
import { listOrgConnections } from "../../models/org-connections.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { SOURCE_ADAPTERS, type SourceAdapter } from "./adapter.js"
import { planSourceRows, type SourceAccessCheck } from "./projection-plan.js"
import type { SourceProvider } from "./sources-file.js"

/**
 * Project `.ctxpipe/sources.yaml` at one Workspace revision into
 * `workspace_sources`. Hydrate reads `text` in its one tree fetch (null when
 * the file is absent). Running it again for the same revision changes nothing.
 */
export async function projectWorkspaceSources(input: {
  orgId: string
  workspaceId: string
  revision: string
  text: string | null
  env: Env
  adapters?: Partial<Record<SourceProvider, SourceAdapter>>
}) {
  const adapters = input.adapters ?? SOURCE_ADAPTERS
  const text = input.text
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
    workspaceId: input.workspaceId,
    revision: input.revision,
    rows,
  })
}
