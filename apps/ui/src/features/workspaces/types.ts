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
  createdAt: string
}

export type WorkspaceListResponse = {
  lastUsedWorkspaceId: string | null
  items: Workspace[]
}
