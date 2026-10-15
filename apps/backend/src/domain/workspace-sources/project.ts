import type { Env } from "../../config/env.js"
import { listOrgConnections } from "../../models/org-connections.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { SOURCE_ADAPTERS, type SourceAdapter } from "./adapter.js"
import { checkGithubSourceAccess } from "./github-access.js"
import { planSourceRows, type SourceAccessCheck } from "./projection-plan.js"
import type { SourceProvider } from "./sources-file.js"

/**
 * The access check of a provider that has no sync adapter. GitHub mirrors no
 * files, so it has only this check.
 */
const SOURCE_ACCESS_CHECKS: Partial<
  Record<SourceProvider, NonNullable<SourceAdapter["checkAccess"]>>
> = { github: checkGithubSourceAccess }

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
  /** The `repositories/*.md` files that cannot move, with the reason. */
  leftoverFiles?: ReadonlyArray<{ path: string; reason: string }>
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
    const check =
      SOURCE_ACCESS_CHECKS[entry.provider] ??
      adapters[entry.provider]?.checkAccess
    if (!check) return null
    return check({
      orgId: input.orgId,
      connectionId: entry.connectionId,
      scope: entry.scope,
      env: input.env,
    })
  }
  const rows = await planSourceRows({
    text,
    connections,
    checkAccess,
    leftoverFiles: input.leftoverFiles,
  })
  return replaceWorkspaceSourceRows({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    revision: input.revision,
    rows,
  })
}
