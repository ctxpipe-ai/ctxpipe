import type { OpenAPIHono } from "@hono/zod-openapi"
import { Webhooks } from "@octokit/webhooks"
import { z } from "zod"
import type { AppEnv } from "../../../app/env.js"
import type { Env } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import {
  getGithubConnectionRowByConnectionId,
  getWebhookSecretForGithubConnection,
  listInstallationsByGithubInstallationId,
  registerInstallationOnConnection,
} from "../../../models/github-installation.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import { ow } from "../../../openworkflow/client.js"
import { enqueueRepositoryIngestionWorkflow } from "../../../openworkflow/enqueue-repository-ingestion.js"
import { syncGithubRepositories } from "../../../openworkflow/workflows/sync-github-repositories.js"
import { maybeEnqueueConfluenceSyncOnConfigPush } from "./github-confluence-push.js"
import { maybeEnqueueNotionSyncOnConfigPush } from "./github-notion-push.js"

const pushPayloadSchema = z.object({
  ref: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  repository: z.object({
    full_name: z.string(),
    default_branch: z.string().nullable().optional(),
  }),
  installation: z.object({ id: z.number() }),
  commits: z
    .array(
      z.object({
        added: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
      }),
    )
    .optional(),
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
  env: Env
}

type ProcessGithubWebhookOpts = {
  /** Present for `POST /api/v1/webhook/github/:connectionId` — used to link installs (`installation`, `installation_repositories`). */
  connectionId?: string
}

async function registerInstallationFromConnectionWebhook(
  connectionId: string,
  installationId: number,
  ctx: GithubWebhookContext,
) {
  const row = await getGithubConnectionRowByConnectionId(connectionId)
  if (!row) {
    ctx.log.info("github_installation_webhook_connection_not_found", {
      connectionId,
    })
    return
  }

  await registerInstallationOnConnection({
    orgId: row.orgId,
    connectionId,
    installationId,
    env: ctx.env,
  })
}

async function enqueueIngestionForInstallationRepos(
  installationId: number,
  repoFullName: string,
  ctx: GithubWebhookContext,
  opts?: { indexingReason: string | null },
) {
  const installationRows =
    await listInstallationsByGithubInstallationId(installationId)
  if (installationRows.length === 0) {
    return
  }

  for (const installationRow of installationRows) {
    const repository = await withOrgDbContext(installationRow.orgId, () =>
      findRepositoryByGithubInstallation(
        installationRow.orgId,
        repoFullName,
        installationRow.id,
      ),
    )
    if (!repository) {
      continue
    }

    await enqueueRepositoryIngestionWorkflow(
      {
        repositoryId: repository.id,
        orgId: repository.orgId,
        indexingReason: opts?.indexingReason ?? null,
      },
      ctx.log,
    )
  }
}

async function processPushEvent(payload: unknown, ctx: GithubWebhookContext) {
  const parsed = pushPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return
  }
  const {
    ref,
    repository: repo,
    installation,
    commits,
    before,
    after,
  } = parsed.data
  const defaultBranch = repo.default_branch
  if (!defaultBranch) {
    return
  }

  await maybeEnqueueConfluenceSyncOnConfigPush({
    installationId: installation.id,
    repoFullName: repo.full_name,
    ref,
    repository: { full_name: repo.full_name, default_branch: defaultBranch },
    commits,
    before,
    after,
    log: ctx.log,
  })

  await maybeEnqueueNotionSyncOnConfigPush({
    installationId: installation.id,
    repoFullName: repo.full_name,
    ref,
    repository: { full_name: repo.full_name, default_branch: defaultBranch },
    commits,
    before,
    after,
    log: ctx.log,
  })

  if (ref !== `refs/heads/${defaultBranch}`) {
    return
  }

  await enqueueIngestionForInstallationRepos(
    installation.id,
    repo.full_name,
    ctx,
    { indexingReason: "push" },
  )
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
        githubConnectionId: installationRow.id,
        reposToSync: [{ name: repo.full_name, gitUrl: repo.clone_url }],
      })
      .catch((err: unknown) => {
        log.error(err instanceof Error ? err : new Error(String(err)))
      })
  }
}

async function processInstallationEvent(
  connectionId: string | undefined,
  payload: unknown,
  ctx: GithubWebhookContext,
) {
  if (!connectionId) return
  const parsed = z
    .object({
      action: z.string(),
      installation: z.object({ id: z.number() }),
    })
    .safeParse(payload)
  if (!parsed.success) return
  if (parsed.data.action !== "created") return

  await registerInstallationFromConnectionWebhook(
    connectionId,
    parsed.data.installation.id,
    ctx,
  )
}

async function processInstallationRepositoriesEvent(
  connectionId: string | undefined,
  payload: unknown,
  ctx: GithubWebhookContext,
) {
  if (!connectionId) return
  const parsed = z
    .object({
      action: z.string(),
      installation: z.object({ id: z.number() }),
    })
    .safeParse(payload)
  if (!parsed.success) return
  if (parsed.data.action !== "added") return

  await registerInstallationFromConnectionWebhook(
    connectionId,
    parsed.data.installation.id,
    ctx,
  )
}

export async function processGithubWebhookPayload(
  eventName: string,
  payload: unknown,
  ctx: GithubWebhookContext,
  opts?: ProcessGithubWebhookOpts,
): Promise<void> {
  switch (eventName) {
    case "ping":
      return
    case "push":
      await processPushEvent(payload, ctx)
      return
    case "repository":
      await processRepositoryEvent(payload, ctx)
      return
    case "installation":
      await processInstallationEvent(opts?.connectionId, payload, ctx)
      return
    case "installation_repositories":
      await processInstallationRepositoriesEvent(
        opts?.connectionId,
        payload,
        ctx,
      )
      return
    default:
      return
  }
}

export function registerGithubWebhookRoute(app: OpenAPIHono<AppEnv>) {
  app.post("/api/v1/webhook/github/:connectionId", async (c) => {
    const env = c.get("env")
    const log = c.get("log")
    const connectionId = c.req.param("connectionId")
    const secret = await getWebhookSecretForGithubConnection(connectionId, env)
    if (!secret) {
      return c.json(
        { error: "Webhook not configured for this connection" },
        503,
      )
    }

    const webhooks = new Webhooks({ secret })
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

    await processGithubWebhookPayload(
      eventName,
      payload,
      { log, env },
      { connectionId },
    )
    return c.body(null, 200)
  })

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

    await processGithubWebhookPayload(eventName, payload, { log, env })
    return c.body(null, 200)
  })
}
