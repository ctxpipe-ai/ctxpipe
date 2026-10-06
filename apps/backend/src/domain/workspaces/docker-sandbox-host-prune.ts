import Docker from "dockerode"
import { withOrgDbContext } from "../../db/client.js"
import {
  getSandboxInstance,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import {
  DOCKER_LABELS,
  removeDockerObject,
  sandboxStoreId,
} from "./workspace-base-providers.js"

/**
 * Keep a self-hosted Docker host from filling up with what no org's sweep
 * chain will remove. Runs once per sweep window on Docker deployments.
 * Each org's own sweep chain removes what its rows record (bases included).
 * This removes only labeled objects of this deployment (by database) that
 * no row records: base images whose base row is gone or names another image
 * (a build that crashed between its capture and its publish) while no build
 * of that row holds its lease, and containers (base builders, and
 * conversation containers started from a base, which inherit the image's
 * labels) that no row records and that are older than `orphanAgeMs` (a
 * create may not have recorded its row yet). Images go with `force`, as in
 * base cleanup (a stopped container keeps working without its image); the
 * daemon refuses images a running container uses. Other deployments' and
 * unlabeled objects are never touched.
 * Not reachable: a container started from the plain chat image whose row was
 * removed without destroying it. Our code never removes such a row while its
 * delete fails (it is kept as `destroy_failed` and retried).
 */
export async function pruneDockerSandboxHost(
  input: {
    docker?: Docker
    orphanAgeMs?: number
    /** Tests prune their own objects only. */
    store?: string
  } = {},
): Promise<{ removedImages: string[]; removedContainers: string[] }> {
  const docker = input.docker ?? new Docker({ timeout: 30_000 })
  const orphanAgeMs = input.orphanAgeMs ?? 60 * 60_000
  const logger = getLogger()
  const store = `${DOCKER_LABELS.store}=${input.store ?? sandboxStoreId()}`
  const owner = (labels: Record<string, string> | undefined) => ({
    orgId: labels?.[DOCKER_LABELS.org],
    baseId: labels?.[DOCKER_LABELS.base],
  })

  const removedImages: string[] = []
  const images = await docker.listImages({
    filters: JSON.stringify({
      label: [store, `${DOCKER_LABELS.kind}=workspace-base`],
    }),
  })
  for (const image of images) {
    const { orgId, baseId } = owner(image.Labels)
    if (!orgId || !baseId) continue
    // Read now, not earlier: a build publishes its row after it commits.
    const row = await getSandboxInstance(baseId, orgId)
    if (row && (row.latestSnapshotId === image.Id || row.leaseHeld)) continue
    if (
      (await removeDockerObject(() =>
        docker.getImage(image.Id).remove({ force: true }),
      )) === "removed"
    )
      removedImages.push(image.Id)
  }

  const removedContainers: string[] = []
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
    if (!orgId || Date.now() - container.Created * 1000 < orphanAgeMs) continue
    if ((await recordedBy(orgId)).has(container.Id)) continue
    if (
      (await removeDockerObject(() =>
        docker.getContainer(container.Id).remove({ force: true, v: true }),
      )) === "removed"
    )
      removedContainers.push(container.Id)
  }

  if (removedImages.length || removedContainers.length)
    logger.info(
      `Removed ${removedImages.length} orphaned base images and ${removedContainers.length} orphaned containers`,
      {
        step: "docker-sandbox-host-prune",
        removedImages: removedImages.length,
        removedContainers: removedContainers.length,
      },
    )
  return { removedImages, removedContainers }
}
