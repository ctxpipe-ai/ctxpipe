export interface Connector {
  id: string
  orgId: string
  type: string
  config: {
    syncMode: "pr" | "auto"
    schedule: "hourly" | "daily" | "manual"
    githubToken?: string
    // Legacy basic-auth
    confluenceBaseUrl?: string
    confluenceEmail?: string
    confluenceApiToken?: string
    // OAuth 2.0
    deploymentType?: "cloud" | "datacenter"
    cloudId?: string
    oauthRefreshToken?: string  // encrypted — present means connected via OAuth
    oauthClientId?: string
    oauthClientSecret?: string
  }
  enabled: boolean
  githubRepoId: string | null
  githubRepoName: string | null
  githubBranch: string | null
  lastPrNumber: number | null
  lastSyncAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ConnectorSpace {
  id: string
  connectorId: string
  spaceKey: string
  spaceName: string | null
  selectedPageIds: string[] | null
  lastSyncedPageId: string | null
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SyncLog {
  id: string
  connectorId: string
  status: string
  prNumber: number | null
  prUrl: string | null
  pagesAdded: number
  pagesUpdated: number
  pagesDeleted: number
  errorMessage: string | null
  startedAt: string
  completedAt: string | null
}
