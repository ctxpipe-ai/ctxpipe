import Docker from "dockerode"
import { withOrgDbContext } from "../../db/client.js"
import {
  getSandboxInstance,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
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
 * chain will remove. Runs once per sweep window on Docker deployments.
 * - Orgs with a conversation sandbox past 30 days, a failed delete, or a base
 *   cleanup may delete are swept now: their chain may have ended (dormant
 *   orgs). Stock containers carry no labels, so this works from
 *   `provider_sandbox_id`.
 * - Labelled objects of this deployment (by database) with no row: base
 *   images whose base row is gone, and containers (base builders, and
 *   conversation containers started from a base, which inherit the image's
 *   labels) that no row records. Images go with `force`, as in base cleanup
 *   (a stopped container keeps working without its image); the daemon
 *   refuses images a running container uses. Other deployments' and
 *   unlabelled objects are never touched.
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
  const logger = getLogger()
  const dormant = await orgsNeedingSweep({ now, includeRunning: false })
  for (const orgId of dormant) {
    try {
      await sweepConversationSandboxes(orgId, now)
    } catch (error) {
      logger.error(error instanceof Error ? error : new Error(String(error)), {
        step: "docker-sandbox-host-prune",
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
    // A build publishes its row after it commits; checked now, not earlier.
    if (!orgId || !baseId || (await getSandboxInstance(baseId, orgId))) continue
    if (
      (await removeDockerObject(() =>
        docker.getImage(image.Id).remove({ force: true }),
      )) === "removed"
    )
      removedImages += 1
  }

  let removedContainers = 0
  /** Container ids each org's rows record, read once per org. */
  const recorded = new Map<string, Promise<Set<string>>>()
  const recordedBy = (orgId: string) => {
    let ids = recorded.get(orgId)
    if (!ids) {
      ids = withOrgDbContext(orgId, () => listSandboxInstances({})).then(
        (rows) =>
          new Set(
            rows.flatMap((row) =>
              row.providerSandboxId ? [row.providerSandboxId] : [],
            ),
          ),
      )
      recorded.set(orgId, ids)
    }
    return ids
  }
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [store] }),
  })
  for (const container of containers) {
    const { orgId } = owner(container.Labels)
    // Younger than an hour: may be a create that has not recorded its row yet.
    if (!orgId || now.getTime() - container.Created * 1000 < 60 * 60_000)
      continue
    if ((await recordedBy(orgId)).has(container.Id)) continue
    if (
      (await removeDockerObject(() =>
        docker.getContainer(container.Id).remove({ force: true, v: true }),
      )) === "removed"
    )
      removedContainers += 1
  }

  if (dormant.length || removedImages || removedContainers)
    logger.info(
      `Swept ${dormant.length} orgs; removed ${removedImages} orphaned base images and ${removedContainers} orphaned containers`,
      {
        step: "docker-sandbox-host-prune",
        sweptOrgs: dormant.length,
        removedImages,
        removedContainers,
      },
    )
  return { sweptOrgs: dormant.length, removedImages, removedContainers }
}
