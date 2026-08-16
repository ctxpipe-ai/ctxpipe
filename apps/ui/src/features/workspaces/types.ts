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
  readOnlyReason: string | null
  mostRecentConversationId: string | null
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
