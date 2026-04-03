export interface AtlassianConnectorStatus {
  isLinked: boolean
  isInstalled: boolean
  installationStatus: string | null
  isGithubLinked: boolean
  selectedSpaceCount: number
  syncTargetConfigured: boolean
}

export interface ConfluenceSpace {
  id: string
  key: string
  name: string
  type: string
}

export interface ConfluencePage {
  id: string
  title: string
  spaceId: string
  parentId?: string
}

export interface ConfluenceScopeRow {
  id: string
  forgeInstallationId: string
  spaceKey: string
  spaceName: string | null
  selectedPageIds: string[] | null
  lastSyncedPageId: string | null
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SpaceScopeItem {
  spaceKey: string
  spaceName?: string
  selectedPageIds: string[] | null
}

export interface ConfluenceSyncTarget {
  id: string
  orgId: string
  forgeInstallationId: string
  repositoryName: string
  branch: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface SaveConfluenceSyncTargetInput {
  repositoryName: string
  branch: string
  enabled: boolean
}

export interface AtlassianConnectorConfig {
  spaces: ConfluenceScopeRow[]
  syncTarget: ConfluenceSyncTarget | null
}
