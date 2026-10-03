import Docker from "dockerode"
import { withOrgDbContext } from "../../db/client.js"
import {
  getSandboxInstance,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import {
  orgsNeedingSweep,
  sweepConversationSandboxes,
} from "./conversation-sandbox-lifecycle.js"
import {
  DOCKER_LABELS,
  removeDockerObject,
  sandboxStoreId,
} from "./workspace-base-providers.js"

/**
 * Keep a self-hosted Docker host from filling up with what no org's sweep
 * chain will remove. Runs from every sandbox sweep on Docker deployments.
 * - Orgs with a conversation sandbox past 30 days (or a failed delete) are
 *   swept now: their chain may have ended (dormant orgs). Stock containers
 *   carry no labels, so this works from `provider_sandbox_id`.
 * - Labelled objects of this deployment (by database) with no row: base
 *   images whose base row is gone, and containers (base builders, and
 *   conversation containers started from a base, which inherit the image's
 *   labels) that no row records. Images go with `force` (stopped containers
 *   keep working without them); the daemon refuses images a running
 *   container uses. Other deployments' and unlabelled objects are never
 *   touched.
 * Not reachable: a container started from the plain chat image whose row was
 * removed without destroying it. Our code never removes such a row while its
 * delete fails (it is kept as `destroy_failed` and retried).
 */
export async function pruneDockerSandboxHost(
  input: { now?: Date; docker?: Docker } = {},
): Promise<{
  sweptOrgs: number
  removedImages: number
  removedContainers: number
}> {
  const now = input.now ?? new Date()
  const docker = input.docker ?? new Docker({ timeout: 30_000 })
  const dormant = await orgsNeedingSweep({ now, includeRunning: false })
  for (const orgId of dormant) {
    try {
      await sweepConversationSandboxes(orgId, now)
    } catch (error) {
      log.error({
        step: "docker-sandbox-host-prune",
        message: `Sweeping an org's expired sandboxes failed: ${String(error)}`,
        orgId,
      })
    }
  }
  const store = `${DOCKER_LABELS.store}=${sandboxStoreId()}`
  const owner = (labels: Record<string, string> | undefined) => ({
    orgId: labels?.[DOCKER_LABELS.org],
    baseId: labels?.[DOCKER_LABELS.base],
  })

  let removedImages = 0
  const images = await docker.listImages({
    filters: JSON.stringify({
      label: [store, `${DOCKER_LABELS.kind}=workspace-base`],
    }),
  })
  for (const image of images) {
    const { orgId, baseId } = owner(image.Labels)
    if (!orgId || !baseId || (await getSandboxInstance(baseId, orgId))) continue
    if (
      (await removeDockerObject(() =>
        docker.getImage(image.Id).remove({ force: true }),
      )) === "removed"
    )
      removedImages += 1
  }

  let removedContainers = 0
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [store] }),
  })
  for (const container of containers) {
    const { orgId } = owner(container.Labels)
    // Younger than an hour: may be a create that has not recorded its row yet.
    if (!orgId || now.getTime() - container.Created * 1000 < 60 * 60_000)
      continue
    const recorded = (
      await withOrgDbContext(orgId, () => listSandboxInstances({}))
    ).some((row) => row.providerSandboxId === container.Id)
    if (recorded) continue
    if (
      (await removeDockerObject(() =>
        docker.getContainer(container.Id).remove({ force: true, v: true }),
      )) === "removed"
    )
      removedContainers += 1
  }

  if (dormant.length || removedImages || removedContainers)
    log.info({
      step: "docker-sandbox-host-prune",
      message: `Swept ${dormant.length} orgs with expired sandboxes; removed ${removedImages} orphaned base images and ${removedContainers} orphaned containers`,
      sweptOrgs: dormant.length,
      removedImages,
      removedContainers,
    })
  return { sweptOrgs: dormant.length, removedImages, removedContainers }
}
