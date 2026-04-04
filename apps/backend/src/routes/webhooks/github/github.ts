import type { OpenAPIHono } from "@hono/zod-openapi"
import { Webhooks } from "@octokit/webhooks"
import { z } from "zod"
import type { AppEnv } from "../../../app/env.js"
import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import { ow } from "../../../openworkflow/client.js"
import { repositoryIngestion } from "../../../openworkflow/repository-ingestion.js"
import { syncGithubRepositories } from "../../../openworkflow/sync-github-repositories.js"

const pushPayloadSchema = z.object({
  ref: z.string(),
  repository: z.object({
    full_name: z.string(),
    default_branch: z.string().nullable().optional(),
  }),
  installation: z.object({ id: z.number() }),
})

const repositoryCreatedSchema = z.object({
  action: z.literal("created"),
  repository: z.object({
    full_name: z.string(),
    clone_url: z.string(),
  }),
  installation: z.object({ id: z.number() }),
})

type GithubWebhookContext = {
  log: AppEnv["Variables"]["log"]
}

async function processPushEvent(
  payload: unknown,
  { log }: GithubWebhookContext,
) {
  const parsed = pushPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return
  }
  const { ref, repository: repo, installation } = parsed.data
  const defaultBranch = repo.default_branch
  if (!defaultBranch) {
    return
  }
  if (ref !== `refs/heads/${defaultBranch}`) {
    return
  }

  const installationRows = await listInstallationsByGithubInstallationId(
    installation.id,
  )
  if (installationRows.length === 0) {
    return
  }

  for (const installationRow of installationRows) {
    const repository = await findRepositoryByGithubInstallation(
      installationRow.orgId,
      repo.full_name,
      installationRow.id,
    )
    if (!repository) {
      continue
    }

    void ow
      .runWorkflow(repositoryIngestion.spec, {
        repositoryId: repository.id,
        orgId: repository.orgId,
      })
      .catch((err: unknown) => {
        log.error(err instanceof Error ? err : new Error(String(err)))
      })
  }
}

async function processRepositoryEvent(
  payload: unknown,
  { log }: GithubWebhookContext,
) {
  const parsed = repositoryCreatedSchema.safeParse(payload)
  if (!parsed.success) {
    return
  }
  const { repository: repo, installation } = parsed.data

  const installationRows = await listInstallationsByGithubInstallationId(
    installation.id,
  )

  for (const installationRow of installationRows) {
    if (
      !installationRow.includeFutureRepos ||
      !installationRow.ingestAllRepositories
    ) {
      continue
    }

    void ow
      .runWorkflow(syncGithubRepositories.spec, {
        orgId: installationRow.orgId,
        reposToSync: [{ name: repo.full_name, gitUrl: repo.clone_url }],
      })
      .catch((err: unknown) => {
        log.error(err instanceof Error ? err : new Error(String(err)))
      })
  }
}

export function registerGithubWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/github", async (c) => {
    const env = c.get("env")
    const log = c.get("log")

    if (!env.GITHUB_WEBHOOK_SECRET) {
      return c.json({ error: "Webhook not configured" }, 503)
    }

    const webhooks = new Webhooks({
      secret: env.GITHUB_WEBHOOK_SECRET,
    })

    const rawBody = await c.req.raw.text()
    const signature = c.req.header("x-hub-signature-256")
    const eventName = c.req.header("x-github-event") ?? ""

    if (!signature || !(await webhooks.verify(rawBody, signature))) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    let payload: unknown
    try {
      payload = JSON.parse(rawBody) as unknown
    } catch {
      return c.json({ error: "Bad request" }, 400)
    }

    switch (eventName) {
      case "ping":
        return c.body(null, 200)
      case "push":
        await processPushEvent(payload, { log })
        return c.body(null, 200)
      case "repository":
        await processRepositoryEvent(payload, { log })
        return c.body(null, 200)
      default:
        return c.body(null, 200)
    }
  })
}
