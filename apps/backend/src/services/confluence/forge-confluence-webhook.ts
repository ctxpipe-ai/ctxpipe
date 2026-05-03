import type { Env } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { runWorkflowWithWorkerWake } from "../../openworkflow/client.js"
import { confluenceSyncSpace } from "../../openworkflow/confluence-sync-space.js"
import { loadConfluenceScopeFromRepo } from "./config-from-repo.js"
import { resetConfluenceConnectorAfterMissingConfig } from "./confluence-setup-reset.js"

export async function handleForgeConfluenceContentEvent(input: {
  orgId: string
  connectionId: string
  env: Env
  spaceKey: string
  pageId?: string
  eventType?: string
}): Promise<"reset" | "skipped" | "enqueued"> {
  const target = await getConfluenceSyncTargetWithRepoByConnectionId(
    input.orgId,
    input.connectionId,
  )
  if (!target?.enabled) return "skipped"

  if (
    target.setupPhase === "awaiting_merge" ||
    target.setupPhase === "initial_sync"
  ) {
    return "skipped"
  }

  const ghConn = target.githubConnectionId
  if (!ghConn) {
    await withOrgDbContext(input.orgId, () =>
      resetConfluenceConnectorAfterMissingConfig({
        connectionId: input.connectionId,
        orgId: input.orgId,
      }),
    )
    return "reset"
  }

  const scope = await loadConfluenceScopeFromRepo({
    orgId: input.orgId,
    env: input.env,
    repositoryName: target.repositoryName,
    githubConnectionId: ghConn,
    branch: target.branch,
  })

  if (!scope) {
    await withOrgDbContext(input.orgId, () =>
      resetConfluenceConnectorAfterMissingConfig({
        connectionId: input.connectionId,
        orgId: input.orgId,
      }),
    )
    return "reset"
  }

  const inYamlScope = scope.spaces.some((s) => s.spaceKey === input.spaceKey)
  if (!inYamlScope) {
    return "skipped"
  }

  void runWorkflowWithWorkerWake(confluenceSyncSpace.spec, {
    orgId: input.orgId,
    connectionId: input.connectionId,
    spaceKey: input.spaceKey,
    pageId: input.pageId,
    eventType: input.eventType,
  })
  return "enqueued"
}
