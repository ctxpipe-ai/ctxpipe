export type Workspace = {
  id: string
  orgId: string
  slug: string
  displayName: string
  workspaceRepositoryUrl: string
  githubConnectionId: string | null
  desiredGeneration: number
  desiredSha: string | null
  activeProjectionUrl: string | null
  activeProjectionSha: string | null
  indexedSha: string | null
  writeStatus: string
  hydrateStatus: string
  hydrateError: string | null
  readOnlyReason: string | null
  mostRecentConversationId: string | null
  migrationExportSha: string | null
  createdAt: string
  updatedAt: string
}

export type WorkspaceDetail = Workspace & {
  linkedRepositories: WorkspaceLinkedRepository[]
}

export type WorkspaceLinkedRepository = {
  id: string
  workspaceId: string
  gitUrl: string
  desiredRef: string | null
  desiredSha: string | null
  indexedSha: string | null
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
  committedAt: string
  htmlUrl: string | null
}

export type WorkspaceActivityResponse = {
  status: "pending" | "ready" | "failed"
  days: WorkspaceActivityDay[]
  recent: WorkspaceActivityCommit[]
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
}

export type WorkspaceGitBlobResponse = {
  path: string
  body: string | null
  binary: boolean
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
  source: "sandbox"
  dirty: boolean
  differsFromDefault: boolean
  unpushed: boolean
  published: boolean
  ahead: number
  behind: number
  items: WorkspaceGitStatusItem[]
}

export type ConversationGitDiffItem = {
  path: string
  oldBody: string | null
  body: string | null
}

export type ConversationGitDiffResponse = {
  items: ConversationGitDiffItem[]
}

export type ConversationFileMutation = {
  path: string
  body?: string
  deletePath?: boolean
  from?: string
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
