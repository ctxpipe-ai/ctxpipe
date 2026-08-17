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
