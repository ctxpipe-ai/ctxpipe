import { parseEnv } from "../config/env.js"
import {
  getOrganizationSlugByOrgId,
  markConfluenceSyncTargetLive,
} from "../models/confluence-sync-target.js"
import { loadConfluenceScopeFromRepo } from "../services/confluence/config-from-repo.js"
import type { ParsedConfluenceRepoConfig } from "../services/confluence/config-yaml.js"
import { ow } from "./client.js"
import { confluenceSyncContent } from "./confluence-sync-content.js"

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

  await markConfluenceSyncTargetLive({ connectionId: input.connectionId })

  void ow
    .runWorkflow(confluenceSyncContent.spec, {
      orgId: input.orgId,
      orgSlug,
      connectionId: input.connectionId,
      scopeFromRepo: {
        spaces: input.scopeFromRepo.spaces.map((s) => ({
          spaceKey: s.spaceKey,
          selectedPageIds: s.selectedPageIds,
        })),
      },
    })
    .catch((err: unknown) => {
      input.log.error(err instanceof Error ? err : new Error(String(err)))
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
