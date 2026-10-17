import type {
  fetchAtlassianConnectorStatus,
  fetchAtlassianSpacePages,
  fetchAtlassianSpaces,
} from "./queries/atlassian-connector"
import type {
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

export interface SpaceScopeItem {
  spaceKey: string
  spaceName?: string
  selectedPageIds: string[] | null
}

export type NotionResource = Awaited<
  ReturnType<typeof searchNotionResources>
>[number]
