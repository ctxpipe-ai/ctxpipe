import { parseEnv } from "../config/env.js"
import { getOrganizationSlugByOrgId } from "../models/confluence-sync-target.js"
import { loadConfluenceScopeFromRepo } from "../services/confluence/config-from-repo.js"
import {
  confluenceSpaceSelection,
  type ParsedConfluenceRepoConfig,
} from "../services/confluence/config-yaml.js"
import {
  connectorConfigKey,
  enqueueConnectorContentSync,
} from "./enqueue-connector-content-sync.js"

export async function enqueueConfluenceFullSyncAfterConfigPush(input: {
  orgId: string
  connectionId: string
  repositoryName: string
  githubConnectionId: string
  branch: string
  scopeFromRepo: ParsedConfluenceRepoConfig
  log: { error: (e: Error) => void }
}): Promise<void> {
  const orgSlug = await getOrganizationSlugByOrgId(input.orgId)
  if (!orgSlug) {
    input.log.error(
      new Error("Organization slug missing for Confluence push sync"),
    )
    return
  }

  await enqueueConnectorContentSync({
    orgId: input.orgId,
    orgSlug,
    connectionId: input.connectionId,
    provider: "confluence",
    branch: input.branch,
    configKey: connectorConfigKey({
      spaces: confluenceSpaceSelection(input.scopeFromRepo.spaces),
    }),
  })
}

export async function loadScopeForGithubPush(input: {
  orgId: string
  repositoryName: string
  githubConnectionId: string
  branch: string
}): Promise<ParsedConfluenceRepoConfig | undefined> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  return loadConfluenceScopeFromRepo({
    orgId: input.orgId,
    env,
    repositoryName: input.repositoryName,
    githubConnectionId: input.githubConnectionId,
    branch: input.branch,
  })
}
