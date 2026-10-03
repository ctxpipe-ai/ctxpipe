import Docker from "dockerode"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  getSandboxInstance,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { CHAT_SANDBOX_RETENTION_MS } from "./chat-lifecycle.js"
import { sweepConversationSandboxes } from "./conversation-sandbox-lifecycle.js"
import {
  DOCKER_BASE_LABEL,
  DOCKER_BASE_LABEL_VALUE,
  DOCKER_BASE_ROW_LABEL,
  DOCKER_BASE_STORE_LABEL,
  sandboxStoreId,
} from "./workspace-base-providers.js"
import { baseRefOfIdentity } from "./workspace-sandbox-base.js"

/**
 * Keep a self-hosted Docker host from filling up with what no org sweep will
 * remove:
 * - stopped conversation containers past 30 days (and failed deletes) in
 *   orgs whose sweep chain has ended: the org's sweep runs now and deletes
 *   them with their rows. Stock containers carry no labels, so this works
 *   from `provider_sandbox_id`;
 * - Workspace base images (labelled by owner and by this deployment's
 *   database) whose base row is gone and that no conversation sandbox
 *   started from. Images another deployment on the same daemon built, and
 *   images a running or stopped container still uses, are left alone.
 */
export async function pruneDockerSandboxHost(
  input: { now?: Date; docker?: Docker } = {},
): Promise<{ sweptOrgs: number; removedImages: number }> {
  const now = input.now ?? new Date()
  const docker = input.docker ?? new Docker({ timeout: 30_000 })
  const orgs = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
  const referenced = new Set<string>()
  let sweptOrgs = 0
  for (const { id } of orgs) {
    try {
      const listRows = () =>
        withOrgDbContext(id, () => listSandboxInstances({}))
      const expired = (await listRows()).some(
        (row) =>
          row.kind === "chat" &&
          row.provider === "docker" &&
          (row.state === "destroy_failed" ||
            now.getTime() - row.lastHeartbeatAt.getTime() >=
              CHAT_SANDBOX_RETENTION_MS),
      )
      if (expired) {
        await sweepConversationSandboxes(id, now)
        sweptOrgs += 1
      }
      for (const row of await listRows()) {
        const ref =
          row.kind === "base"
            ? row.latestSnapshotId
            : baseRefOfIdentity(row.image)
        if (ref) referenced.add(ref)
      }
    } catch (error) {
      log.error({
        step: "docker-sandbox-host-prune",
        message: `Pruning an org's expired sandboxes failed: ${String(error)}`,
        orgId: id,
      })
    }
  }
  const images = await docker.listImages({
    filters: JSON.stringify({
      label: [
        `${DOCKER_BASE_LABEL}=${DOCKER_BASE_LABEL_VALUE}`,
        `${DOCKER_BASE_STORE_LABEL}=${sandboxStoreId()}`,
      ],
    }),
  })
  let removedImages = 0
  for (const image of images) {
    if (referenced.has(image.Id)) continue
    // A build publishes its row after it commits; checked now, not when listed.
    const baseId = image.Labels?.[DOCKER_BASE_ROW_LABEL]
    const orgId = image.Labels?.["ai.ctxpipe.org"]
    if (!baseId || !orgId) continue
    if (await getSandboxInstance(baseId, orgId)) continue
    try {
      await docker.getImage(image.Id).remove()
      removedImages += 1
    } catch (error) {
      // 404: already gone. 409: a container still uses it.
      const status = (error as { statusCode?: number }).statusCode
      if (status !== 404 && status !== 409) throw error
    }
  }
  if (sweptOrgs || removedImages)
    log.info({
      step: "docker-sandbox-host-prune",
      message: `Swept ${sweptOrgs} orgs with expired sandboxes and removed ${removedImages} unused base images`,
      sweptOrgs,
      removedImages,
    })
  return { sweptOrgs, removedImages }
}
