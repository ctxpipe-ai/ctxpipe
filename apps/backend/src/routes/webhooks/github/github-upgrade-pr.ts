import { z } from "zod"
import type { AppEnv } from "../../../app/env.js"
import type { Env } from "../../../config/env.js"
import { UPGRADE_BRANCH_PREFIX } from "../../../domain/upgrades/registry.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { enqueueWorkspaceUpgradeScan } from "../../../openworkflow/workflows/workspace-upgrade-scan.js"
import { logGithubWebhookNoOrganization } from "./github-webhook-miss.js"

const closedPullRequestSchema = z.object({
  action: z.literal("closed"),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ ref: z.string() }),
    closed_at: z.string().nullable().optional(),
  }),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
})

/**
 * A closed pull request of an upgrade branch queues an upgrade scan for each
 * org of the installation. Without a merge, the scan sets the upgrade back to
 * `awaiting_operator` with a note. After a merge, the push webhook queues the
 * hydrate, and the format change queues the scan that completes the upgrade.
 */
export async function maybeEnqueueUpgradeScanForPullRequest(input: {
  payload: unknown
  githubConnectionId?: string
  env: Env
  log: AppEnv["Variables"]["log"]
}): Promise<void> {
  const parsed = closedPullRequestSchema.safeParse(input.payload)
  if (
    !parsed.success ||
    !parsed.data.pull_request.head.ref.startsWith(UPGRADE_BRANCH_PREFIX)
  )
    return
  const { pull_request: pull, repository, installation } = parsed.data
  const installations = await listInstallationsByGithubInstallationId(
    installation.id,
    input.githubConnectionId,
    input.env,
  )
  if (installations.length === 0)
    await logGithubWebhookNoOrganization(
      {
        event: "pull_request.closed",
        installationId: installation.id,
        githubConnectionId: input.githubConnectionId,
      },
      input.env,
      input.log,
    )
  for (const { orgId } of installations)
    await enqueueWorkspaceUpgradeScan({
      orgId,
      trigger: `pr:${repository.full_name}:${pull.number}:${pull.closed_at ?? "closed"}`,
    })
}
