import { parseEnv } from "../config/env.js"
import {
  getOrganizationSlugByOrgId,
  markConfluenceSyncTargetInitialSync,
} from "../models/confluence-sync-target.js"
import {
  getConnectorContentSyncGeneration,
  reconcileConnectorContentSync,
} from "../models/connector-content-sync.js"
import { loadConfluenceScopeFromRepo } from "../services/confluence/config-from-repo.js"
import type { ParsedConfluenceRepoConfig } from "../services/confluence/config-yaml.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { confluenceSyncContent } from "./workflows/confluence-sync-content.js"

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

  await markConfluenceSyncTargetInitialSync({
    connectionId: input.connectionId,
  })

  const contentSyncGeneration = await getConnectorContentSyncGeneration(
    input.orgId,
    input.connectionId,
  )
  try {
    await runWorkflowWithWorkerWake(
      confluenceSyncContent.spec,
      {
        orgId: input.orgId,
        orgSlug,
        connectionId: input.connectionId,
        contentSyncGeneration,
        scopeFromRepo: {
          spaces: input.scopeFromRepo.spaces.map((s) => ({
            spaceKey: s.spaceKey,
            selectedPageIds: s.selectedPageIds,
          })),
        },
      },
      {
        idempotencyKey: `connector-content:${input.connectionId}:${contentSyncGeneration}`,
      },
    )
  } catch (error) {
    if (
      await reconcileConnectorContentSync({
        orgId: input.orgId,
        connectionId: input.connectionId,
        admissionFailedGeneration: contentSyncGeneration,
      })
    )
      return
    throw error
  }
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
