import {
  completeSyncLog,
  createSyncLog,
  type SyncLogRecord,
} from "../../models/connector-sync-logs.js"
import {
  listConnectorSpaces,
  updateConnectorSpace,
} from "../../models/connector-spaces.js"
import { getConnector, updateConnector } from "../../models/connectors.js"
import {
  generateConnectorYaml,
  syncConfigYaml,
  type ConnectorYamlConfig,
} from "../config-yaml.js"
import { ConfluenceClient, type ConfluenceClientConfig } from "./client.js"
import { ConfluenceToMarkdownConverter } from "./converter.js"
import { GitHubClient, type FileChange } from "../github/client.js"

export interface SyncOptions {
  connectorId: string
  orgId: string
  confluenceConfig: ConfluenceClientConfig
  githubConfig: {
    token: string
    owner: string
    repo: string
    branch: string
  }
  syncMode: "pr" | "auto"
}

export interface SyncResult {
  success: boolean
  pagesAdded: number
  pagesUpdated: number
  pagesDeleted: number
  prNumber?: number
  prUrl?: string
  error?: string
}

export interface ConfigSyncResult {
  success: boolean
  prNumber?: number
  prUrl?: string
  noChange?: boolean
  error?: string
}

export class ConfluenceSyncOrchestrator {
  private converter = new ConfluenceToMarkdownConverter()

  // Content sync — direct commit to main (no PR).
  // Respects selectedPageIds per space.
  async sync(options: SyncOptions): Promise<SyncResult> {
    const syncLog = await createSyncLog({
      connectorId: options.connectorId,
      status: "started",
    })

    try {
      const result = await this.performContentSync(options, syncLog)

      await completeSyncLog(syncLog.id, {
        status: result.success ? "completed" : "failed",
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        pagesAdded: result.pagesAdded,
        pagesUpdated: result.pagesUpdated,
        pagesDeleted: result.pagesDeleted,
        errorMessage: result.error,
      })

      if (result.success) {
        await updateConnector(options.connectorId, {
          lastSyncAt: new Date(),
          lastPrNumber: result.prNumber,
        })
      }

      return result
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error"

      await completeSyncLog(syncLog.id, {
        status: "failed",
        errorMessage,
      })

      return {
        success: false,
        pagesAdded: 0,
        pagesUpdated: 0,
        pagesDeleted: 0,
        error: errorMessage,
      }
    }
  }

  // Config sync — generates config.yaml and opens a PR if it differs from main.
  async syncConfig(options: SyncOptions): Promise<ConfigSyncResult> {
    const connector = await getConnector(options.connectorId)
    if (!connector) {
      return { success: false, error: `Connector not found: ${options.connectorId}` }
    }

    const spaces = await listConnectorSpaces(options.connectorId)
    if (spaces.length === 0) {
      return {
        success: false,
        error: "No spaces configured. Add at least one space before saving config.",
      }
    }

    const github = new GitHubClient(options.githubConfig)

    const yamlConfig: ConnectorYamlConfig = {
      type: "confluence",
      baseUrl: connector.config.confluenceBaseUrl,
      spaces: spaces.map((s) => ({
        key: s.spaceKey,
        name: s.spaceName,
        selectedPageIds: s.selectedPageIds,
      })),
    }

    try {
      const pr = await syncConfigYaml({
        github,
        connectorType: "confluence",
        config: yamlConfig,
        branch: options.githubConfig.branch,
      })

      if (!pr) {
        return { success: true, noChange: true }
      }

      return { success: true, prNumber: pr.number, prUrl: pr.url }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error"
      return { success: false, error: errorMessage }
    }
  }

  private async performContentSync(
    options: SyncOptions,
    _syncLog: SyncLogRecord,
  ): Promise<SyncResult> {
    const connector = await getConnector(options.connectorId)
    if (!connector) {
      throw new Error(`Connector not found: ${options.connectorId}`)
    }

    const confluence = new ConfluenceClient(options.confluenceConfig)
    const github = new GitHubClient(options.githubConfig)

    const spaces = await listConnectorSpaces(options.connectorId)
    if (spaces.length === 0) {
      return {
        success: false,
        pagesAdded: 0,
        pagesUpdated: 0,
        pagesDeleted: 0,
        error: "No spaces configured. Add at least one Confluence space key to the connector.",
      }
    }

    const files: FileChange[] = []
    let pagesAdded = 0
    let pagesUpdated = 0

    for (const space of spaces) {
      const confluenceSpace = await confluence.getSpace(space.spaceKey)

      console.log(`[sync] fetching pages for space key=${space.spaceKey} id=${confluenceSpace.id}`)
      let pageCount = 0
      let skippedWrongSpace = 0

      for await (const page of confluence.getPagesInSpace(confluenceSpace.id)) {
        // Defensive: discard any page the API returns that doesn't belong to this space
        if (page.spaceId !== confluenceSpace.id) {
          skippedWrongSpace++
          console.warn(`[sync] skipping page id=${page.id} spaceId=${page.spaceId} (expected ${confluenceSpace.id})`)
          continue
        }

        // Filter by selectedPageIds if set
        if (
          space.selectedPageIds !== null &&
          space.selectedPageIds !== undefined &&
          !space.selectedPageIds.includes(page.id)
        ) {
          continue
        }

        pageCount++

        const conversion = this.converter.convert(page)
        // Files go under confluence/{spaceKey}/ within the repo
        const filePath = this.converter.generateFilePath(page, space.spaceKey)
        const content = this.converter.formatWithFrontmatter(conversion)

        files.push({ path: filePath, content })

        if (space.lastSyncedPageId) {
          pagesUpdated++
        } else {
          pagesAdded++
        }

        await updateConnectorSpace(space.id, {
          lastSyncedPageId: page.id,
          lastSyncedAt: new Date(),
        })
      }

      console.log(`[sync] space ${space.spaceKey}: ${pageCount} page(s) included, ${skippedWrongSpace} skipped (wrong space)`)
    }

    if (files.length === 0) {
      return {
        success: false,
        pagesAdded: 0,
        pagesUpdated: 0,
        pagesDeleted: 0,
        error: "No pages found in the configured Confluence spaces.",
      }
    }

    // Always include a current config.yaml snapshot so the directory is
    // self-documenting even before the user has run a scope-config PR.
    const yamlConfig: ConnectorYamlConfig = {
      type: "confluence",
      baseUrl: connector.config.confluenceBaseUrl,
      spaces: spaces.map((s) => ({
        key: s.spaceKey,
        name: s.spaceName,
        selectedPageIds: s.selectedPageIds,
      })),
    }
    files.push({
      path: "confluence/config.yaml",
      content: generateConnectorYaml(yamlConfig),
    })

    // Compute deletions: any file currently in confluence/ that isn't being
    // written in this sync is either out of scope or was deleted in Confluence.
    const newPaths = new Set(files.map((f) => f.path))
    console.log(`[sync] writing ${files.length} file(s): ${[...newPaths].slice(0, 5).join(", ")}${files.length > 5 ? " ..." : ""}`)

    const existingPaths = await github.listFilesInTree(
      options.githubConfig.branch,
      "confluence/",
    )
    console.log(`[sync] found ${existingPaths.length} existing file(s) in confluence/ on branch=${options.githubConfig.branch}`)

    const deletions = existingPaths.filter((p) => !newPaths.has(p))
    if (deletions.length > 0) {
      console.log(`[sync] deleting ${deletions.length} out-of-scope file(s): ${deletions.slice(0, 10).join(", ")}${deletions.length > 10 ? " ..." : ""}`)
    } else {
      console.log(`[sync] no deletions required`)
    }

    // Content changes commit directly to main — no PR
    await github.commitFiles(
      options.githubConfig.branch,
      `chore: sync Confluence content - ${new Date().toISOString()}`,
      files,
      deletions,
    )

    return {
      success: true,
      pagesAdded,
      pagesUpdated,
      pagesDeleted: deletions.length,
    }
  }

  private generatePRBody(
    pagesAdded: number,
    pagesUpdated: number,
    spacesCount: number,
  ): string {
    return [
      "## Confluence Sync",
      "",
      `This PR syncs documentation from ${spacesCount} Confluence space(s).`,
      "",
      "### Summary",
      `- **Pages added:** ${pagesAdded}`,
      `- **Pages updated:** ${pagesUpdated}`,
      "",
      "### Notes",
      "- Files are organised by Confluence space key under `confluence/`",
      "- Each file includes frontmatter with Confluence metadata",
      "- Original Confluence formatting has been converted to Markdown",
    ].join("\n")
  }
}

export const syncOrchestrator = new ConfluenceSyncOrchestrator()
