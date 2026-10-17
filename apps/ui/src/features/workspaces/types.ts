export type Workspace = {
  id: string
  orgId: string
  slug: string
  displayName: string
  workspaceRepositoryUrl: string
  /** Folder in the repository that holds the Workspace; "" is the whole repository. */
  rootPath: string
  githubConnectionId: string | null
  desiredGeneration: number
  desiredSha: string | null
  activeProjectionUrl: string | null
  activeProjectionSha: string | null
  indexedSha: string | null
  /** Server capability; older responses retain the write-status fallback. */
  conversationWritable?: boolean
  writeStatus: string
  hydrateStatus: string
  hydrateError: string | null
  readOnlyReason: string | null
  mostRecentConversationId: string | null
  createdAt: string
  updatedAt: string
}

export type WorkspaceSkippedFile = {
  path: string
  reason: "malformed" | "duplicate_repository"
}

export type WorkspaceStorePhase = { kind: "pending" | "ready" | "failed" }

export type WorkspaceDetail = Workspace & {
  linkedRepositories: WorkspaceLinkedRepository[]
  /** Absent on a detail seeded from the list. */
  skippedFiles?: WorkspaceSkippedFile[]
  /** Absent on a detail seeded from the list. */
  hydratePhases?: { graph: WorkspaceStorePhase }
}

export type WorkspaceLinkedRepository = {
  id: string
  workspaceId: string
  gitUrl: string
  desiredRef: string | null
  desiredSha: string | null
  indexedSha: string | null
  /** Org repository index health, e.g. `complete_with_issues`. */
  indexingStatus?: string | null
  indexingError?: string | null
  createdAt: string
}

export type WorkspaceListResponse = {
  lastUsedWorkspaceId: string | null
  items: Workspace[]
}

export type WorkspaceActivityDay = {
  date: string
  count: number
}

export type WorkspaceActivityCommit = {
  sha: string
  subject: string
  authorName: string
  /** The GitHub login of the author. `null`: no GitHub user. */
  authorLogin?: string | null
  committedAt: string
  htmlUrl: string | null
  workspaceSlug: string
  workspaceName: string
}

export type WorkspaceActivityResponse = {
  status: "pending" | "ready" | "failed"
  days: WorkspaceActivityDay[]
  recent: WorkspaceActivityCommit[]
  /** The authors of the commits in the heatmap window, most active first. */
  authors: { name: string; count: number; login?: string | null }[]
  /** The cursor of the next page of `recent`. `null`: no more commits. */
  nextCursor: string | null
  /** Org read only: the workspaces whose activity is still loading. */
  pendingWorkspaces?: { slug: string; name: string }[]
}

export type WorkspaceFile = {
  path: string
  body: string
}

export type WorkspaceFileTreeNode = {
  name: string
  path: string
  children?: WorkspaceFileTreeNode[]
}

export type WorkspaceFilesResponse = {
  items: WorkspaceFile[]
  tree: WorkspaceFileTreeNode[]
}

export type WorkspaceGitTreeResponse = {
  sha: string
  paths: string[]
}

export type ConversationGitTreeResponse = WorkspaceGitTreeResponse & {
  branch: string
  ready?: boolean
  worktreeVersion?: string
}

export type WorkspaceGitBlobResponse = {
  path: string
  body: string | null
  binary: boolean
  /** Set for knowledge from before Workspaces that is not in git. */
  readOnlyReason?: string
}

export type WorkspaceGitStatus =
  | "added"
  | "deleted"
  | "ignored"
  | "modified"
  | "renamed"
  | "untracked"

export type WorkspaceGitStatusItem = {
  path: string
  status: WorkspaceGitStatus
  body?: string | null
  additions?: number
  deletions?: number
}

export type WorkspaceGitStatusResponse = {
  sha: string
  source: "sandbox" | "clean"
  items: WorkspaceGitStatusItem[]
}

export type ConversationGitStatusResponse = {
  branch: string | null
  sha?: string | null
  desiredSha?: string | null
  stale?: boolean
  source: "sandbox"
  dirty: boolean
  differsFromDefault: boolean
  unpushed: boolean
  published: boolean
  ahead: number
  behind: number
  items: WorkspaceGitStatusItem[]
  worktreeVersion?: string
}

/** One changed file, as the backend's git diff gives it. */
export type ChangedFile = {
  path: string
  /** The path before a rename. */
  oldPath?: string
  status: "added" | "modified" | "deleted" | "renamed"
  additions: number
  deletions: number
  /** Why the file has no bodies; the UI shows this in place of a diff. */
  omitted?: "binary" | "too_large" | "not_a_file"
}

export type ConversationGitDiffItem = ChangedFile & {
  oldBody: string | null
  body: string | null
}

export type ConversationGitDiffResponse = {
  /** The branch the diff compares against. */
  base?: string
  items: ConversationGitDiffItem[]
  /** The turn's snapshots are no longer in the sandbox (410). */
  gone?: boolean
}

export type ConversationTurnChanges = {
  runId: string
  /**
   * The number of user messages in the thread when the turn ended. It places
   * the card only when no message carries the run id (a failed turn).
   */
  turn: number
  files: ChangedFile[]
}

/** One push of the conversation's commits to its branch. */
export type ConversationSync = {
  /** What pushed: the user's Sync or Create PR, the agent, or the sweep. */
  trigger: "sync" | "create_pr" | "agent" | "sweep"
  /** Create PR: the pull request; `opened` when this push opened it. */
  pullRequest?: { number: number; url: string; opened: boolean }
  branch: string
  sha: string
  /** The number of files that the pushed commits changed. */
  files: number
  treeUrl: string
  /** The number of user messages in the thread at the time of the Sync. */
  turn: number
  syncedAt: string
}

export type ConversationTurnChangesResponse = {
  items: ConversationTurnChanges[]
  syncs: ConversationSync[]
}

export type ConversationFileMutation = {
  path: string
  body?: string
  deletePath?: boolean
  from?: string
  expectedWorktreeVersion: string
}

export type ConversationFileWriteResponse = WorkspaceGitBlobResponse & {
  worktreeVersion: string
  tree: ConversationGitTreeResponse
  status: ConversationGitStatusResponse
}

export type ConversationPushResponse = {
  branch: string
  treeUrl: string
}

export type ConversationPullRequestResponse = {
  branch: string
  prNumber: number
  pullUrl: string
  prState: "open" | "closed" | "merged"
}

export type WorkspaceFileJobRequest =
  | { op: "save"; path: string; content: string }
  | { op: "create"; path: string; kind: "file" | "folder"; content?: string }
  | { op: "rename"; from: string; to: string }
  | { op: "move"; from: string; toDirectory: string | null }
  | { op: "delete"; path: string }

export type WorkspaceGraphPayload = {
  metrics: {
    totalNodes: number
    totalEdges: number
    lastUpdatedAt: string | null
    nodesReturned: number
    edgesReturned: number
    truncated: boolean
  }
  nodes: Array<{
    id: string
    kind: string
    name: string | null
    summary: string | null
  }>
  edges: Array<{
    sourceId: string
    targetId: string
    predicate: string
    lastObservedAt: string | null
    confidence: number | null
  }>
}
