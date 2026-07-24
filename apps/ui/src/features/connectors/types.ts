export interface AtlassianConnectorStatusSpacePreview {
  spaceKey: string
  spaceName: string | null
}

export interface AtlassianConnectorStatus {
  isLinked: boolean
  isInstalled: boolean
  installationStatus: string | null
  isGithubLinked: boolean
  selectedSpaceCount: number
  syncTargetConfigured: boolean
  /** draft | awaiting_merge | initial_sync | live */
  setupPhase: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  syncTarget: {
    repositoryId: string
    repositoryName: string
    branch: string
  } | null
  selectedSpaces: AtlassianConnectorStatusSpacePreview[]
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
  connectionId: string
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
  connectionId: string
  repositoryId: string
  repositoryName: string
  branch: string
  enabled: boolean
  setupPhase: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  createdAt: string
  updatedAt: string
}

export interface SaveConfluenceSyncTargetInput {
  repositoryId: string
  branch: string
  enabled: boolean
}

export interface AtlassianConnectorConfig {
  spaces: ConfluenceScopeRow[]
  syncTarget: ConfluenceSyncTarget | null
}

export interface NotionResource {
  externalId: string
  type: "page" | "database"
  title: string
  url?: string | null
  parentExternalId?: string | null
}

export interface NotionConnectorStatus {
  isInstalled: boolean
  installationStatus: string | null
  workspaceName: string | null
  isGithubLinked: boolean
  selectedResourceCount: number
  syncTargetConfigured: boolean
  setupPhase: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  syncTarget: {
    repositoryId: string
    repositoryName: string
    branch: string
  } | null
  selectedResources: Array<{
    externalId: string
    type: "page" | "database"
    title: string
  }>
}

export interface NotionSyncTarget {
  id: string
  orgId: string
  connectionId: string
  repositoryId: string
  repositoryName: string
  branch: string
  enabled: boolean
  setupPhase: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  createdAt: string
  updatedAt: string
}

export interface NotionConnectorConfig {
  resources: Array<
    NotionResource & {
      id: string
      createdAt: string
      updatedAt: string
      lastSyncedAt: string | null
    }
  >
  syncTarget: NotionSyncTarget | null
}
