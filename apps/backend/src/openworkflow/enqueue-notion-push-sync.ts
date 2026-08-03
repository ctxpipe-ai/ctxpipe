import { parseEnv } from "../config/env.js"
import {
  getOrganizationSlugForNotionOrgId,
  markNotionSyncTargetInitialSync,
} from "../models/notion-connector.js"
import { loadNotionScopeFromRepo } from "../services/notion/config-from-repo.js"
import type { ParsedNotionRepoConfig } from "../services/notion/config-yaml.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { notionSyncContent } from "./workflows/notion-sync-content.js"

export async function enqueueNotionFullSyncAfterConfigPush(input: {
  orgId: string
  connectionId: string
  scopeFromRepo: ParsedNotionRepoConfig
}): Promise<void> {
  const orgSlug = await getOrganizationSlugForNotionOrgId(input.orgId)
  if (!orgSlug) {
    throw new Error("Organization slug missing for Notion push sync")
  }

  await markNotionSyncTargetInitialSync({ connectionId: input.connectionId })

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
