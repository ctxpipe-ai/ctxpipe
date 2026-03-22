import type { OpenAPIHono } from "@hono/zod-openapi"
import { Webhooks } from "@octokit/webhooks"
import { z } from "zod"
import type { AppEnv } from "../app/env.js"
import { getInstallationByGithubInstallationId } from "../models/github-installation.js"
import { findRepositoryForWebhookPush } from "../models/repositories.js"
import { ow } from "../openworkflow/client.js"
import { repositoryIngestion } from "../openworkflow/repository-ingestion.js"
import { syncGithubRepositories } from "../openworkflow/sync-github-repositories.js"

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

export function registerGithubWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/github/webhook", async (c) => {
    const env = c.get("env")
    const log = c.get("log")

    if (!env.GITHUB_WEBHOOK_SECRET) {
      return c.json({ error: "Webhook not configured" }, 503)
    }

    const webhooks = new Webhooks({
      secret: env.GITHUB_WEBHOOK_SECRET,
    })

    const rawBody = await c.req.text()
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

    if (eventName === "ping") {
      return c.body(null, 200)
    }

    if (eventName === "push") {
      const parsed = pushPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        return c.body(null, 200)
      }
      const { ref, repository: repo, installation } = parsed.data
      const defaultBranch = repo.default_branch
      if (!defaultBranch) {
        return c.body(null, 200)
      }
      if (ref !== `refs/heads/${defaultBranch}`) {
        return c.body(null, 200)
      }

      const installationRow = await getInstallationByGithubInstallationId(
        installation.id,
      )
      if (!installationRow) {
        return c.body(null, 200)
      }

      const repository = await findRepositoryForWebhookPush(
        installationRow.orgId,
        repo.full_name,
        installationRow.id,
      )
      if (!repository) {
        return c.body(null, 200)
      }

      void ow
        .runWorkflow(repositoryIngestion.spec, {
          repositoryId: repository.id,
          orgId: repository.orgId,
        })
        .catch((err: unknown) => {
          log.error(
            err instanceof Error ? err : new Error(String(err)),
          )
        })

      return c.body(null, 200)
    }

    if (eventName === "repository") {
      const parsed = repositoryCreatedSchema.safeParse(payload)
      if (!parsed.success) {
        return c.body(null, 200)
      }
      const { repository: repo, installation } = parsed.data

      const installationRow = await getInstallationByGithubInstallationId(
        installation.id,
      )
      if (!installationRow) {
        return c.body(null, 200)
      }

      if (
        !installationRow.includeFutureRepos ||
        !installationRow.ingestAllRepositories
      ) {
        return c.body(null, 200)
      }

      void ow
        .runWorkflow(syncGithubRepositories.spec, {
          orgId: installationRow.orgId,
          reposToSync: [
            { name: repo.full_name, gitUrl: repo.clone_url },
          ],
        })
        .catch((err: unknown) => {
          log.error(
            err instanceof Error ? err : new Error(String(err)),
          )
        })

      return c.body(null, 200)
    }

    return c.body(null, 200)
  })
}
