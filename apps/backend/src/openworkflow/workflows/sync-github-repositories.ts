import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { recordAgentActivityEvent } from "../../models/agent-activity-events.js"
import {
  getGithubInstallationByConnectionId,
  listAllReposForInstallation,
} from "../../models/github-installation.js"
import { bulkCreateRepositoriesForOrg } from "../../models/repositories.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const reposToSyncItemSchema = z.object({
  name: z.string(),
  gitUrl: z.string(),
})

const syncGithubRepositoriesInputSchema = z.object({
  orgId: z.string().min(1),
  githubConnectionId: z.string().min(1),
  userId: z.string().min(1).optional(),
  reposToSync: z.array(reposToSyncItemSchema).optional(),
})

export const syncGithubRepositories = defineWorkflow(
  {
    name: "sync-github-repositories",
    schema: syncGithubRepositoriesInputSchema,
  },
  async ({ input, step }) =>
    withLogger(
      createLogger({
        workflow: "sync-github-repositories",
        orgId: input.orgId,
        githubConnectionId: input.githubConnectionId,
      }),
      async () => {
        const installation = await step.run(
          { name: "get-installation" },
          async () => {
            const row = await getGithubInstallationByConnectionId(
              input.orgId,
              input.githubConnectionId,
            )
            if (!row) {
              throw new Error(
                `No GitHub connection ${input.githubConnectionId} for org ${input.orgId}`,
              )
            }
            return row
          },
        )

        const resolvedRepos = await step.run(
          { name: "resolve-repos" },
          async () => {
            if (input.reposToSync !== undefined) {
              return input.reposToSync
            }
            if (installation.installationId == null) {
              throw new Error(
                `GitHub connection ${installation.id} has no installation_id yet; complete GitHub App installation first`,
              )
            }
            const repos = await listAllReposForInstallation(
              input.orgId,
              input.githubConnectionId,
              parseEnv(process.env as Record<string, string | undefined>),
            )
            return repos.map((r) => ({
              name: r.full_name,
              gitUrl: r.clone_url,
            }))
          },
        )

        const created = await step.run({ name: "bulk-create" }, () =>
          bulkCreateRepositoriesForOrg(input.orgId, resolvedRepos, {
            githubConnectionId: installation.id,
          }),
        )

        if (input.userId) {
          await step.run({ name: "record-activity" }, () =>
            Promise.all(
              created.map((repo) =>
                recordAgentActivityEvent({
                  orgId: input.orgId,
                  userId: input.userId,
                  source: "repository",
                  eventType: "repository.created",
                  subjectId: repo.id,
                  metadata: {
                    name: repo.name,
                    gitUrl: repo.gitUrl,
                    githubConnectionId: installation.id,
                  },
                }).catch((err) => {
                  getLogger().warn("dashboard_activity_event_write_failed", {
                    error: err instanceof Error ? err.message : String(err),
                    source: "repository",
                    repositoryId: repo.id,
                  })
                }),
              ),
            ),
          )
        }

        await Promise.all(
          created.map((repo) =>
            step.run({ name: `ingest-${repo.id}` }, () =>
              runRepositoryIngestionWorkflow(
                { repositoryId: repo.id, orgId: repo.orgId },
                {
                  error: (err) =>
                    getLogger().error(err, {
                      step: "sync-github-repositories.ingestion",
                      repositoryId: repo.id,
                    }),
                },
              ),
            ),
          ),
        )

        return { orgId: input.orgId, createdCount: created.length }
      },
    ),
)
