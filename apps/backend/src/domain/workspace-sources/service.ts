import { randomBytes } from "node:crypto"
import { requireCurrentOrgId } from "../../auth/context.js"
import { parseEnv } from "../../config/env.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import { listOrgConnections } from "../../models/org-connections.js"
import {
  listConnectionSourceRows,
  listGithubConnectionWorkspaces,
  listWorkspaceSourceRows,
  type WorkspaceSourceRow,
} from "../../models/workspace-sources.js"
import { listRefusedLinkEdits } from "../../models/workspace-write-jobs.js"
import {
  listOrgWorkspaces,
  type WorkspaceRecord,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueWorkspaceWriteCommit } from "../../openworkflow/enqueue-workspace-write-commit.js"
import type {
  ConnectionUsageResponse,
  WorkspaceSourceBatchResult,
  WorkspaceSourceChangeResult,
  WorkspaceSourceListResponse,
} from "../../routes/v1/workspace-sources-contract.js"
import { listMarkdownFilesAtGitSha } from "../../services/git/clone-tree.js"
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
  sourceAddPath,
} from "./edit.js"
import { FILE_ERROR_SOURCE_KEY } from "./projection-plan.js"
import { workspaceGithubRepository } from "./repository.js"
import {
  checkSourcePath,
  SOURCE_FILE_MAX_BYTES,
  SOURCE_FILES_FOLDER,
} from "./source-file.js"
import { parseSourceFile } from "./source-file-text.js"
import { SOURCES_FOLDER_PREFIX } from "./source-tree.js"
import {
  SOURCE_SCOPES,
  type SourceProvider,
  sourceProviderSchema,
  summarizeSourceScope,
} from "./sources-file.js"
import { overlaySourceStatus } from "./status-overlay.js"

/**
 * Source PR branches: `ctxpipe/sources/<action>/<name>/<suffix>`. `<name>` is
 * the source path without `sources/` and `.md` (for example
 * `github/acme/web`). A rename names both paths: `<old>/_to_/<new>`. A path
 * segment never starts with `_`, so `_to_` cannot be a segment. `<suffix>` is
 * the time and a random part, so two requests never share a branch.
 */
const SOURCE_BRANCH_PREFIX = "ctxpipe/sources/"
const SOURCE_BRANCH =
  /^ctxpipe\/sources\/(add|edit|rename|remove)\/(.+)\/[a-z0-9]+-[a-f0-9]+$/
const RENAME_SEPARATOR = "/_to_/"
/** A batch add names each path in one branch: `<a>/_and_/<b>`. */
const BATCH_SEPARATOR = "/_and_/"

function branchNameOf(path: string): string {
  return path.slice(`${SOURCE_FILES_FOLDER}/`.length, -".md".length)
}

function pathOfBranchName(name: string): string {
  return `${SOURCE_FILES_FOLDER}/${name}.md`
}

function sourceBranch(change: SourceChange, paths: string[]): string {
  const name =
    change.action === "rename"
      ? `${branchNameOf(change.path)}${RENAME_SEPARATOR}${branchNameOf(change.newPath)}`
      : paths.map(branchNameOf).join(BATCH_SEPARATOR)
  const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
  return `${SOURCE_BRANCH_PREFIX}${change.action}/${name}/${suffix}`
}

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
      if (!match) return []
      const action = match[1] as "add" | "edit" | "rename" | "remove"
      const name = match[2] ?? ""
      // A batch add has one branch for several paths: one entry for each.
      const parts = action === "add" ? name.split(BATCH_SEPARATOR) : [name]
      return parts.flatMap((part) => {
        const [from, to] = part.split(RENAME_SEPARATOR)
        const path = pathOfBranchName(from ?? "")
        const checked = checkSourcePath(path)
        if (!checked.ok) return []
        return [
          {
            path,
            // The new path of a rename: an add must not take it.
            ...(to ? { newPath: pathOfBranchName(to) } : {}),
            provider: checked.provider,
            action,
            pullRequestUrl: pull.pullUrl,
            createdAt: pull.createdAt,
          },
        ]
      })
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
 * remove, an edit, or a rename needs its source path there, and an add needs
 * the path to be free. A change that happened another way leaves its pull request open.
 * While the file cannot be read, every pull request shows.
 */
function stillApplies(
  change: { action: SourceChange["action"]; path: string },
  sourcePaths: ReadonlySet<string>,
): boolean {
  if (sourcePaths.has(FILE_ERROR_SOURCE_KEY)) return true
  return change.action === "add"
    ? !sourcePaths.has(change.path)
    : sourcePaths.has(change.path)
}

/**
 * The body of each source file at the served revision, by path: one tree read
 * of `sources/` from git. A file over the size limit has no body here. The
 * list still answers without bodies when git cannot be read.
 */
async function readSourceBodies(
  workspace: WorkspaceRecord,
  revision: string | undefined,
): Promise<Map<string, string>> {
  const bodies = new Map<string, string>()
  if (!revision) return bodies
  try {
    const env = parseEnv(process.env)
    const repository = workspaceGithubRepository(workspace, env)
    // The list runs inside the org transaction, so this reads the credential
    // without `resolveRepositoryReadCredential`, which refuses that.
    const token = repository
      ? await getRepoReadCloneToken(workspace.orgId, env, {
          repoFullName: repository.repositoryName,
          githubConnectionId: repository.githubConnectionId,
        })
      : undefined
    const files = await listMarkdownFilesAtGitSha({
      url: workspace.workspaceRepositoryUrl,
      sha: revision,
      extraFolders: [SOURCES_FOLDER_PREFIX],
      token,
    })
    for (const file of files) {
      if (!file.path.startsWith(SOURCES_FOLDER_PREFIX)) continue
      if (Buffer.byteLength(file.content) > SOURCE_FILE_MAX_BYTES) continue
      const parsed = parseSourceFile(file.path, file.content)
      const body = parsed.ok ? parsed.body.trim() : ""
      if (body) bodies.set(file.path, body)
    }
  } catch (error) {
    getLogger().warn("Could not read the source file bodies", {
      step: "workspace_sources.read_bodies",
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return bodies
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
  const bodies = await readSourceBodies(workspace, rows[0]?.revision)
  const fileRow = rows.find((row) => row.sourceKey === FILE_ERROR_SOURCE_KEY)
  const sourcePaths = new Set(projected.map((row) => row.sourceKey))
  return {
    path: SOURCE_FILES_FOLDER,
    revision: rows[0]?.revision ?? null,
    fileError: fileRow?.statusDetail ?? null,
    items: rows
      .filter((row) => row.sourceKey !== FILE_ERROR_SOURCE_KEY)
      .map((row) => ({
        path: row.sourceKey,
        provider: sourceProviderSchema.safeParse(row.provider).data ?? null,
        connectionId: row.connectionId,
        connectionName: row.connectionId
          ? (names.get(row.connectionId) ?? null)
          : null,
        scope: row.scope,
        scopeSummary: scopeSummary(row),
        status: row.status,
        statusDetail: row.statusDetail,
        ...(bodies.has(row.sourceKey)
          ? { description: bodies.get(row.sourceKey) }
          : {}),
        // A row of a legacy entry or of a repository file has no source
        // file that a remove can name.
        removable: checkSourcePath(row.sourceKey).ok,
        revision: row.revision,
        updatedAt: row.updatedAt.toISOString(),
      })),
    ...editPolicy(workspace),
    pendingChanges: (await pendingChanges(workspace))
      .filter((change) => stillApplies(change, sourcePaths))
      .map(({ newPath: _newPath, ...change }) => change),
    linkErrors: (await listRefusedLinkEdits(workspace.id)).map((edit) => ({
      ...edit,
      failedAt: edit.failedAt.toISOString(),
    })),
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

/** The connected repository, after the read-only and delivery checks. */
function assertCanDeliver(
  workspace: WorkspaceRecord,
  delivery: "pull_request" | "commit",
) {
  const repository = workspaceGithubRepository(workspace)
  if (!repository)
    throw new SourceChangeError(
      409,
      "This Workspace has no connected GitHub repository",
    )
  const policy = editPolicy(workspace)
  if (!policy.canEdit)
    throw new SourceChangeError(409, "This Workspace is read-only")
  if (delivery === "commit" && !policy.directCommitAllowed)
    throw new SourceChangeError(
      409,
      "This Workspace does not accept a direct commit. Use a pull request.",
    )
  return repository
}

/** The projected sources of the Workspace, as the change checks read them. */
async function projectedSources(workspace: WorkspaceRecord) {
  return (
    await listWorkspaceSourceRows({
      orgId: workspace.orgId,
      workspaceId: workspace.id,
    })
  )
    .filter((row) => row.sourceKey !== FILE_ERROR_SOURCE_KEY)
    .map((row) => ({
      path: row.sourceKey,
      provider: row.provider,
      scope: row.scope,
    }))
}

/** Read the named files from the default branch (git is the truth, not the projection). */
async function readSourceFiles(
  repository: NonNullable<ReturnType<typeof workspaceGithubRepository>>,
  paths: string[],
) {
  return (
    await Promise.all(
      paths.map(async (path) => ({
        path,
        content: await getFileContent({ ...repository, path }),
      })),
    )
  ).flatMap(({ path, content }) =>
    content === undefined ? [] : [{ path, content }],
  )
}

/** Commit the files by a queued direct commit or by one pull request. */
async function deliverSourceFiles(input: {
  workspace: WorkspaceRecord
  repository: NonNullable<ReturnType<typeof workspaceGithubRepository>>
  delivery: "pull_request" | "commit"
  change: SourceChange
  writes: Array<{ path: string; content: string }>
  deletes: string[]
  /** The paths that the change adds, changes, or removes. */
  paths: string[]
  provider: SourceProvider
}): Promise<
  | { outcome: "commit_queued" }
  | { outcome: "pull_request"; pullRequestUrl: string }
> {
  const { workspace, change } = input
  if (input.delivery === "commit") {
    const admitted = await enqueueWorkspaceWriteCommit(
      {
        orgId: workspace.orgId,
        workspaceId: workspace.id,
        kind: "ui_file_edit",
        mergeFiles: input.writes,
        mergeDeletePaths: input.deletes,
      },
      getLogger(),
    )
    if (!admitted.started)
      throw new SourceChangeError(
        409,
        "The commit could not be queued. Refresh the Workspace and try again.",
      )
    return { outcome: "commit_queued" }
  }
  const verb = {
    add: "Add",
    edit: "Change",
    rename: "Rename",
    remove: "Remove",
  }[change.action]
  const label = SOURCE_SCOPES[input.provider].label
  const many = input.paths.length > 1
  const subject = many
    ? `${input.paths.length} sources`
    : `the ${label} source "${input.paths[0]}"`
  // `branch` is the default branch. For createPullRequestWithFiles, `branch`
  // is the head of the pull request, so do not pass it.
  const { branch: baseBranch, ...target } = input.repository
  const pull = await createPullRequestWithFiles({
    ...target,
    baseBranch,
    branch: sourceBranch(change, input.paths),
    requireNewBranch: true,
    title: `${verb} ${subject}`,
    body: `ctx| changes ${input.paths.map((path) => `\`${path}\``).join(", ")}. When you merge this pull request, the Workspace syncs the new sources.`,
    commitMessage: many
      ? `${verb} ${input.paths.length} sources`
      : `${verb} the ${input.paths[0]} source`,
    files: input.writes,
    deletePaths: input.deletes,
  })
  return { outcome: "pull_request", pullRequestUrl: pull.pullUrl }
}

/** A new path must be free of every open source pull request. */
async function reservedPathsOf(workspace: WorkspaceRecord) {
  // An open "remove linear" would otherwise remove a new "linear" when it merges.
  return new Set(
    (await pendingChanges(workspace)).flatMap((pull) =>
      pull.newPath ? [pull.path, pull.newPath] : [pull.path],
    ),
  )
}

/**
 * Change one file under `sources/` on the Workspace default branch: by a PR
 * (awaiting merge) or by a queued direct commit. A rename is one move of the
 * file; the hydrate of the new revision changes the `sources` list of each
 * unit that names the old path. The checks read the projected sources and
 * only the files that the change names. The projection follows the files
 * when the change lands; nothing here writes `workspace_sources`.
 */
export async function changeWorkspaceSource(input: {
  workspace: WorkspaceRecord
  change: SourceChange
  delivery: "pull_request" | "commit"
}): Promise<WorkspaceSourceChangeResult> {
  const { workspace, change } = input
  assertSourceChangeShape(change)
  const repository = assertCanDeliver(workspace, input.delivery)
  if (change.action === "add" || change.action === "edit")
    await assertConnection(
      workspace.orgId,
      change.provider,
      change.connectionId,
    )
  const sources = await projectedSources(workspace)
  const reservedPaths =
    change.action === "add" || change.action === "rename"
      ? await reservedPathsOf(workspace)
      : undefined
  // Read only the files that the change names, from the default branch: the
  // projection can be behind git.
  const paths =
    change.action === "add"
      ? [
          change.path ??
            sourceAddPath(
              change,
              new Set([
                ...sources.map((source) => source.path),
                ...(reservedPaths ?? []),
              ]),
            ),
        ]
      : change.action === "rename"
        ? [change.path, change.newPath]
        : [change.path]
  const files = await readSourceFiles(repository, paths)
  const next = applySourceFileChange({
    files,
    // Git is the truth for each path that the change reads.
    sources: sources.filter((source) => !paths.includes(source.path)),
    change: change.action === "add" ? { ...change, path: paths[0] } : change,
    reservedPaths,
  })
  const delivered = await deliverSourceFiles({
    workspace,
    repository,
    delivery: input.delivery,
    change,
    writes: next.writes,
    deletes: next.deletes,
    paths: [next.path],
    provider: next.provider,
  })
  return delivered.outcome === "commit_queued"
    ? { outcome: "commit_queued", path: next.path }
    : {
        outcome: "pull_request",
        path: next.path,
        pullRequestUrl: delivered.pullRequestUrl,
      }
}

/**
 * Add several sources in one pull request (or one direct commit). Each add is
 * checked as `changeWorkspaceSource` checks it, and also against the files
 * that the earlier adds of the batch write, so two adds of one repository
 * are refused. One refused add refuses the whole batch.
 */
export async function addWorkspaceSources(input: {
  workspace: WorkspaceRecord
  changes: Array<Extract<SourceChange, { action: "add" }>>
  delivery: "pull_request" | "commit"
}): Promise<WorkspaceSourceBatchResult> {
  const { workspace, changes } = input
  if (!changes.length)
    throw new SourceChangeError(400, "Add at least one source")
  for (const change of changes) assertSourceChangeShape(change)
  const repository = assertCanDeliver(workspace, input.delivery)
  for (const change of changes)
    await assertConnection(
      workspace.orgId,
      change.provider,
      change.connectionId,
    )
  const sources = await projectedSources(workspace)
  const reservedPaths = await reservedPathsOf(workspace)
  const taken = new Set([
    ...sources.map((source) => source.path),
    ...reservedPaths,
  ])
  const paths: string[] = []
  for (const change of changes) {
    const path = change.path ?? sourceAddPath(change, taken)
    taken.add(path)
    paths.push(path)
  }
  const existing = await readSourceFiles(repository, paths)
  const written: Array<{ path: string; content: string }> = []
  let provider: SourceProvider | undefined
  for (const [index, change] of changes.entries()) {
    const next = applySourceFileChange({
      files: [...existing, ...written],
      sources: sources.filter((source) => !paths.includes(source.path)),
      change: { ...change, path: paths[index] },
      reservedPaths,
    })
    written.push(...next.writes)
    provider ??= next.provider
  }
  const delivered = await deliverSourceFiles({
    workspace,
    repository,
    delivery: input.delivery,
    change: changes[0] as SourceChange,
    writes: written,
    deletes: [],
    paths,
    provider: provider as SourceProvider,
  })
  return delivered.outcome === "commit_queued"
    ? { outcome: "commit_queued", paths }
    : {
        outcome: "pull_request",
        paths,
        pullRequestUrl: delivered.pullRequestUrl,
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
      path: source.sourceKey,
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
    const sourcePaths = new Set(
      (await listWorkspaceSourceRows({ orgId, workspaceId: workspace.id })).map(
        (row) => row.sourceKey,
      ),
    )
    const applying = changes.filter((change) =>
      stillApplies(change, sourcePaths),
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
    item.pendingChanges = applying.map(
      ({ newPath: _newPath, ...change }) => change,
    )
    byWorkspace.set(workspace.id, item)
  }
  return { items: [...byWorkspace.values()] }
}
