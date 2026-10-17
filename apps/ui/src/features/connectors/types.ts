import type {
  fetchAtlassianConnectorStatus,
  fetchAtlassianSpacePages,
  fetchAtlassianSpaces,
} from "./queries/atlassian-connector"
import type {
  fetchNotionConnectorStatus,
  searchNotionResources,
} from "./queries/notion-connector"

export type AtlassianConnectorStatus = Awaited<
  ReturnType<typeof fetchAtlassianConnectorStatus>
>

export type AtlassianConnectorStatusSpacePreview =
  AtlassianConnectorStatus["selectedSpaces"][number]

export type ConfluenceSpace = Awaited<
  ReturnType<typeof fetchAtlassianSpaces>
>[number]

export type ConfluencePage = Awaited<
  ReturnType<typeof fetchAtlassianSpacePages>
>[number]

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

export type NotionResource = Awaited<
  ReturnType<typeof searchNotionResources>
>[number]

export interface SuggestedConnectorSyncTarget {
  repositoryId: string
  repositoryName: string
  gitUrl: string
  branch: string
  githubConnectionId: string
  usedBy: Array<"confluence" | "notion" | "linear" | "slack">
}

export type NotionConnectorStatus = Awaited<
  ReturnType<typeof fetchNotionConnectorStatus>
>

export interface NotionSyncTarget {
  id: string
  orgId: string
  connectionId: string
  repositoryId: string
  repositoryName: string
  branch: string
  githubConnectionId: string | null
  enabled: boolean
  setupPhase: string
  pendingConfigPullUrl: string | null
  pendingConfigPrCreating: boolean
  createdAt: string
  updatedAt: string
}
