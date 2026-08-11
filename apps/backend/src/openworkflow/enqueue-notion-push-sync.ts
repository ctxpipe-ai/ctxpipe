import { parseEnv } from "../config/env.js"
import {
  claimNotionBindingInitialSync,
  getOrganizationSlugForNotionOrgId,
  transitionNotionBindingState,
} from "../models/notion-connector.js"
import { loadNotionScopeFromRepo } from "../services/notion/config-from-repo.js"
import type { ParsedNotionRepoConfig } from "../services/notion/config-yaml.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { notionSyncContent } from "./workflows/notion-sync-content.js"

export async function enqueueNotionFullSyncAfterConfigPush(input: {
  orgId: string
  connectionId: string
  repositoryId: string
  branch: string
  scopeFromRepo: ParsedNotionRepoConfig
}): Promise<void> {
  const orgSlug = await getOrganizationSlugForNotionOrgId(input.orgId)
  if (!orgSlug) {
    throw new Error("Organization slug missing for Notion push sync")
  }

  const claimed = await claimNotionBindingInitialSync({
    connectionId: input.connectionId,
    repositoryId: input.repositoryId,
    branch: input.branch,
  })
  if (!claimed) return

  try {
    await runWorkflowWithWorkerWake(notionSyncContent.spec, {
      orgId: input.orgId,
      orgSlug,
      connectionId: input.connectionId,
      scopeFromRepo: {
        resources: input.scopeFromRepo.resources.map((resource) => ({
          externalId: resource.externalId,
          type: resource.type,
          title: resource.title,
        })),
      },
    })
  } catch (error) {
    await transitionNotionBindingState({
      connectionId: input.connectionId,
      expectedSetupPhase: "initial_sync",
      expectedPendingConfigPrCreating: false,
      repositoryId: input.repositoryId,
      branch: input.branch,
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      setupPhase: "awaiting_merge",
    })
    throw error
  }
}

export async function loadNotionScopeForGithubPush(input: {
  orgId: string
  repositoryName: string
  githubConnectionId: string
  branch: string
}): Promise<ParsedNotionRepoConfig | undefined> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  return loadNotionScopeFromRepo({
    orgId: input.orgId,
    env,
    repositoryName: input.repositoryName,
    githubConnectionId: input.githubConnectionId,
    branch: input.branch,
  })
}
