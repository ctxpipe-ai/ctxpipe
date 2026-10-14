import { requireCurrentOrgId } from "../../auth/context.js"
import { listOrgConnections } from "../../models/org-connections.js"
import {
  listConnectionSourceRows,
  listGithubConnectionWorkspaces,
  listWorkspaceSourceRows,
  type WorkspaceSourceRow,
} from "../../models/workspace-sources.js"
import {
  listOrgWorkspaces,
  type WorkspaceRecord,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import type {
  ConnectionUsageResponse,
  WorkspaceSourceChangeResult,
  WorkspaceSourceListResponse,
} from "../../routes/v1/workspace-sources-contract.js"
import {
  createPullRequestWithFiles,
  getFileContent,
  listOpenPullRequestsByBranchPrefix,
} from "../../services/github/installation-write-client.js"
import { workspaceAllowsConversationEdits } from "../workspaces/chat-sandbox-policy.js"
import { WORKSPACE_WRITE_STATUSES } from "../workspaces/write-status.js"
import { SOURCE_ADAPTERS } from "./adapter.js"
import {
  applySourceFileChange,
  assertSourceChangeShape,
  type SourceChange,
  SourceChangeError,
} from "./edit.js"
import { FILE_ERROR_SOURCE_KEY } from "./projection-plan.js"
import { workspaceGithubRepository } from "./repository.js"
import {
  SOURCE_SCOPES,
  SOURCES_FILE_PATH,
  type SourceProvider,
  sourceProviderSchema,
  summarizeSourceScope,
} from "./sources-file.js"
import { overlaySourceStatus } from "./status-overlay.js"

/** Source PR branches: `ctxpipe/sources/<action>/<provider>/<key>-<ms>`. */
const SOURCE_BRANCH_PREFIX = "ctxpipe/sources/"
const SOURCE_BRANCH =
  /^ctxpipe\/sources\/(add|edit|remove)\/([a-z]+)\/(.+)-\d+$/

function scopeSummary(row: WorkspaceSourceRow): string {
  const provider = sourceProviderSchema.safeParse(row.provider)
  if (!provider.success || row.status === "invalid")
    return row.statusDetail ?? "Invalid entry"
  return summarizeSourceScope(provider.data, row.scope)
}

/**
 * Every org member who can open the Workspace can change it (no Workspace
 * roles yet). A PR needs a connected repository that ctx| can push a branch
 * to; a direct commit also needs an unprotected default branch.
 */
function editPolicy(workspace: WorkspaceRecord) {
  const connected = workspaceGithubRepository(workspace) !== null
  return {
    canEdit:
      connected &&
      workspaceAllowsConversationEdits(
        workspace.writeStatus,
        workspace.readOnlyReason,
      ),
    directCommitAllowed:
      connected && workspace.writeStatus === WORKSPACE_WRITE_STATUSES.writable,
  }
}

async function pendingChanges(
  workspace: Parameters<typeof workspaceGithubRepository>[0] & { id: string },
) {
  const repository = workspaceGithubRepository(workspace)
  if (!repository) return []
  try {
    const pulls = await listOpenPullRequestsByBranchPrefix({
      ...repository,
      branchPrefix: SOURCE_BRANCH_PREFIX,
    })
    return pulls.flatMap((pull) => {
      const match = SOURCE_BRANCH.exec(pull.branch)
      const provider = sourceProviderSchema.safeParse(match?.[2])
      if (!match || !provider.success) return []
      return [
        {
          sourceKey: match[3] ?? "",
          provider: provider.data,
          action: match[1] as "add" | "edit" | "remove",
          pullRequestUrl: pull.pullUrl,
          createdAt: pull.createdAt,
        },
      ]
    })
  } catch (error) {
    // The list still shows the projection when GitHub cannot answer.
    getLogger().warn("Could not list the source pull requests", {
      step: "workspace_sources.pending_changes",
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Whether a source pull request still applies to the default branch: a
 * remove or an edit needs its source id there, and an add needs the id to be
 * free. A change that happened another way leaves its pull request open.
 * While the file cannot be read, every pull request shows.
 */
function stillApplies(
  change: { action: SourceChange["action"]; sourceKey: string },
  sourceKeys: ReadonlySet<string>,
): boolean {
  if (sourceKeys.has(FILE_ERROR_SOURCE_KEY)) return true
  return change.action === "add"
    ? !sourceKeys.has(change.sourceKey)
    : sourceKeys.has(change.sourceKey)
}

export async function listWorkspaceSources(
  workspace: WorkspaceRecord,
): Promise<WorkspaceSourceListResponse> {
  const projected = await listWorkspaceSourceRows({
    orgId: workspace.orgId,
    workspaceId: workspace.id,
  })
  const names = new Map(
    (await listOrgConnections(workspace.orgId)).map((item) => [
      item.id,
      item.displayName,
    ]),
  )
  const rows = await overlaySourceStatus({
    orgId: workspace.orgId,
    rows: projected,
    connectionIds: new Set(names.keys()),
    adapters: SOURCE_ADAPTERS,
  })
  const fileRow = rows.find((row) => row.sourceKey === FILE_ERROR_SOURCE_KEY)
  const sourceKeys = new Set(projected.map((row) => row.sourceKey))
  return {
    path: SOURCES_FILE_PATH,
    revision: rows[0]?.revision ?? null,
    fileError: fileRow?.statusDetail ?? null,
    items: rows
      .filter((row) => row.sourceKey !== FILE_ERROR_SOURCE_KEY)
      .map((row) => ({
        sourceKey: row.sourceKey,
        provider: sourceProviderSchema.safeParse(row.provider).data ?? null,
        connectionId: row.connectionId,
        connectionName: row.connectionId
          ? (names.get(row.connectionId) ?? null)
          : null,
        scope: row.scope,
        scopeSummary: scopeSummary(row),
        status: row.status,
        statusDetail: row.statusDetail,
        revision: row.revision,
        updatedAt: row.updatedAt.toISOString(),
      })),
    ...editPolicy(workspace),
    pendingChanges: (await pendingChanges(workspace)).filter((change) =>
      stillApplies(change, sourceKeys),
    ),
  }
}

async function assertConnection(
  orgId: string,
  provider: SourceProvider,
  connectionId: string,
) {
  const connection = (await listOrgConnections(orgId)).find(
    (item) => item.id === connectionId,
  )
  if (!connection)
    throw new SourceChangeError(400, "The connection does not exist")
  const expected = SOURCE_SCOPES[provider].connectionType
  if (connection.type !== expected)
    throw new SourceChangeError(
      400,
      `The connection is a ${connection.type} connection, not ${expected}`,
    )
}

/**
 * Change `.ctxpipe/sources.yaml` on the Workspace default branch: by a PR
 * (awaiting merge) or by a queued direct commit. The projection follows the
 * file when the change lands; nothing here writes `workspace_sources`.
 */
export async function changeWorkspaceSource(input: {
  workspace: WorkspaceRecord
  change: SourceChange
  delivery: "pull_request" | "commit"
}): Promise<WorkspaceSourceChangeResult> {
  const { workspace, change } = input
  assertSourceChangeShape(change)
  const repository = workspaceGithubRepository(workspace)
  if (!repository)
    throw new SourceChangeError(
      409,
      "This Workspace has no connected GitHub repository",
    )
  const policy = editPolicy(workspace)
  if (!policy.canEdit)
    throw new SourceChangeError(409, "This Workspace is read-only")
  if (input.delivery === "commit" && !policy.directCommitAllowed)
    throw new SourceChangeError(
      409,
      "This Workspace does not accept a direct commit. Use a pull request.",
    )
  if (change.action !== "remove")
    await assertConnection(
      workspace.orgId,
      change.provider,
      change.connectionId,
    )
  const current = await getFileContent({
    ...repository,
    path: SOURCES_FILE_PATH,
  })
  // A new id must also be free of every open source pull request: an open
  // "remove linear" would otherwise remove a new "linear" when it merges.
  const reservedKeys =
    change.action === "add"
      ? new Set((await pendingChanges(workspace)).map((pull) => pull.sourceKey))
      : undefined
  const next = applySourceFileChange(current ?? null, change, reservedKeys)

  if (input.delivery === "commit") {
    const admitted = await enqueueWorkspaceWriteCommit(
      {
        orgId: workspace.orgId,
        workspaceId: workspace.id,
        kind: "ui_file_edit",
        mergeFiles: [{ path: SOURCES_FILE_PATH, content: next.text }],
        mergeDeletePaths: [],
      },
      getLogger(),
    )
    if (!admitted.started)
      throw new SourceChangeError(
        409,
        "The commit could not be queued. Refresh the Workspace and try again.",
      )
    return { outcome: "commit_queued", sourceKey: next.sourceKey }
  }

  const verb = { add: "Add", edit: "Change", remove: "Remove" }[change.action]
  const label = next.provider ? SOURCE_SCOPES[next.provider].label : "unknown"
  // `branch` is the default branch. For createPullRequestWithFiles, `branch`
  // is the head of the pull request, so do not pass it.
  const { branch: baseBranch, ...target } = repository
  const pull = await createPullRequestWithFiles({
    ...target,
    baseBranch,
    featureBranchPrefix: `${SOURCE_BRANCH_PREFIX}${change.action}/${next.provider ?? "unknown"}/${next.sourceKey}`,
    title: `${verb} the ${label} source "${next.sourceKey}"`,
    body: `ctx| changes \`${SOURCES_FILE_PATH}\`. When you merge this pull request, the Workspace syncs the new sources.`,
    commitMessage: `${verb} the ${next.sourceKey} source`,
    files: [{ path: SOURCES_FILE_PATH, content: next.text }],
  })
  return {
    outcome: "pull_request",
    sourceKey: next.sourceKey,
    pullRequestUrl: pull.pullUrl,
  }
}

export async function listConnectionUsage(
  connectionId: string,
): Promise<ConnectionUsageResponse | null> {
  const orgId = requireCurrentOrgId()
  const connection = (await listOrgConnections(orgId)).find(
    (item) => item.id === connectionId,
  )
  if (!connection) return null
  const rows = await listConnectionSourceRows({ orgId, connectionId })
  const byWorkspace = new Map<
    string,
    ConnectionUsageResponse["items"][number]
  >()
  for (const { source, workspaceSlug, workspaceName } of rows) {
    const provider = sourceProviderSchema.safeParse(source.provider)
    if (!provider.success) continue
    const item = byWorkspace.get(source.workspaceId) ?? {
      workspaceId: source.workspaceId,
      workspaceSlug,
      workspaceName,
      stat: "",
      sources: [],
      pendingChanges: [],
    }
    item.sources.push({
      sourceKey: source.sourceKey,
      provider: provider.data,
      status: source.status,
      scopeSummary: scopeSummary(source),
    })
    item.stat = item.sources.map((entry) => entry.scopeSummary).join(", ")
    byWorkspace.set(source.workspaceId, item)
  }
  if (connection.type === "github") {
    // A GitHub connection also reads each Workspace repository and linked
    // repository bound to it, with or without a source entry.
    for (const usage of await listGithubConnectionWorkspaces({
      orgId,
      connectionId,
    })) {
      const count = usage.linkedRepositories
      const stat = [
        usage.workspaceRepository ? "Workspace repository" : null,
        count
          ? `${count} linked ${count === 1 ? "repository" : "repositories"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
      byWorkspace.set(usage.workspaceId, {
        workspaceId: usage.workspaceId,
        workspaceSlug: usage.workspaceSlug,
        workspaceName: usage.workspaceName,
        sources: byWorkspace.get(usage.workspaceId)?.sources ?? [],
        stat,
        pendingChanges: [],
      })
    }
  }
  // An open source pull request waits for a merge. Show it, so the user does
  // not add the source again. The branch names the provider, not the
  // connection, so each connection of that provider shows it.
  const providers = new Set(
    Object.entries(SOURCE_SCOPES)
      .filter(([, scope]) => scope.connectionType === connection.type)
      .map(([provider]) => provider),
  )
  const workspaces = await listOrgWorkspaces(orgId)
  const pending = await Promise.all(
    workspaces.map((workspace) => pendingChanges({ ...workspace, orgId })),
  )
  for (const [index, workspace] of workspaces.entries()) {
    const changes = (pending[index] ?? []).filter((change) =>
      providers.has(change.provider),
    )
    if (!changes.length) continue
    const sourceKeys = new Set(
      (await listWorkspaceSourceRows({ orgId, workspaceId: workspace.id })).map(
        (row) => row.sourceKey,
      ),
    )
    const applying = changes.filter((change) =>
      stillApplies(change, sourceKeys),
    )
    if (!applying.length) continue
    const item = byWorkspace.get(workspace.id) ?? {
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.displayName,
      stat: "",
      sources: [],
      pendingChanges: [],
    }
    item.pendingChanges = applying
    byWorkspace.set(workspace.id, item)
  }
  return { items: [...byWorkspace.values()] }
}
