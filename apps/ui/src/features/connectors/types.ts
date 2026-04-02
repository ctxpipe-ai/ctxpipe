export interface AtlassianConnectorStatus {
  isLinked: boolean
  isInstalled: boolean
  installationStatus: string | null
  isGithubLinked: boolean
  selectedSpaceCount: number
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
