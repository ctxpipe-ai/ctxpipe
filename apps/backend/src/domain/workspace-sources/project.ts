import { eq } from "drizzle-orm"
import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { listOrgConnections } from "../../models/org-connections.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { SOURCE_ADAPTERS, type SourceAdapter } from "./adapter.js"
import { unconvertedEntryIds } from "./convert-to-files.js"
import { linkPlainGitSource } from "./first-ingestion.js"
import { checkGithubSourceAccess } from "./github-access.js"
import {
  planSourceRows,
  type SourceAccessCheck,
  type SourceFileBlob,
} from "./projection-plan.js"
import type { SourceProvider } from "./sources-file.js"

/**
 * The access check of a provider that has no sync adapter. GitHub mirrors no
 * files, so it has only this check.
 */
const SOURCE_ACCESS_CHECKS: Partial<
  Record<SourceProvider, NonNullable<SourceAdapter["checkAccess"]>>
> = { github: checkGithubSourceAccess }

/**
 * Project the sources of one Workspace revision into `workspace_sources`:
 * each file under `sources/` and, until the conversion is done (CTX-721
 * T11), each entry of `.ctxpipe/sources.yaml`. Hydrate reads `text` and
 * `files` in its one tree fetch. The rows of the previous revision decide
 * the winner of a conflict across sources. Running it again for the same
 * revision changes nothing.
 */
export async function projectWorkspaceSources(input: {
  orgId: string
  workspaceId: string
  revision: string
  /** The text of `.ctxpipe/sources.yaml`, or null when it is absent. */
  text: string | null
  /** Every blob under `sources/` at the revision. */
  files?: ReadonlyArray<SourceFileBlob>
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
    if (!check || !entry.connectionId) return null
    return check({
      orgId: input.orgId,
      connectionId: entry.connectionId,
      scope: entry.scope,
      env: input.env,
    })
  }
  const previous = await listWorkspaceSourceRows({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
  })
  const [workspace] = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({ url: workspaces.workspaceRepositoryUrl })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId)),
  )
  const rows = await planSourceRows({
    text,
    files: input.files,
    connections,
    checkAccess,
    leftoverFiles: input.leftoverFiles,
    workspaceUrl: workspace?.url ?? null,
    previousRows: previous,
    managedPaths: (entry) =>
      adapters[entry.provider]?.managedPaths(entry.scope) ?? [],
  })
  const projected = await replaceWorkspaceSourceRows({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    revision: input.revision,
    rows,
    movedFrom: unconvertedEntryIds(input.files ?? []),
  })
  // A plain git source has no connection, so it has no access check. Link
  // its repository after the rows name it, so that its first ingestion
  // finds the source path.
  for (const row of rows)
    if (row.provider === "git" && row.status === "ok")
      await linkPlainGitSource({ orgId: input.orgId, scope: row.scope })
  return projected
}
