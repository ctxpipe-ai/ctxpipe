import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../config/env.js"
import {
  getInstallationByOrgId,
  listAllReposForInstallation,
} from "../models/github-installation.js"
import { bulkCreateRepositoriesForOrg } from "../models/repositories.js"
import { createLogger, getLogger, withLogger } from "../observability/logger.js"
import { repositoryIngestion } from "./repository-ingestion.js"

const reposToSyncItemSchema = z.object({
  name: z.string(),
  gitUrl: z.string(),
})

const syncGithubRepositoriesInputSchema = z.object({
  orgId: z.string().min(1),
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
      }),
      async () => {
        const logger = getLogger()
        logger.info("github repository sync started", {
          requestedRepositoryCount: input.reposToSync?.length ?? null,
        })
        const installation = await step.run(
          { name: "get-installation" },
          async () => {
            const row = await getInstallationByOrgId(input.orgId)
            if (!row) {
              logger.warn("github repository sync had no installation", {
                orgId: input.orgId,
              })
              throw new Error(
                `No GitHub installation found for org ${input.orgId}`,
              )
            }
            logger.set({ installationId: row.installationId })
            return row
          },
        )

        const resolvedRepos = await step.run(
          { name: "resolve-repos" },
          async () => {
            if (input.reposToSync !== undefined) {
              return input.reposToSync
            }
            const repos = await listAllReposForInstallation(
              installation.installationId,
              parseEnv(process.env as Record<string, string | undefined>),
            )
            return repos.map((r) => ({
              name: r.full_name,
              gitUrl: r.clone_url,
            }))
          },
        )
        logger.info("github repository sync resolved repositories", {
          resolvedRepositoryCount: resolvedRepos.length,
          usedExplicitSelection: input.reposToSync !== undefined,
        })

        const created = await step.run({ name: "bulk-create" }, () =>
          bulkCreateRepositoriesForOrg(input.orgId, resolvedRepos, {
            githubInstallationId: installation.id,
          }),
        )
        logger.info("github repository sync created repositories", {
          createdRepositoryCount: created.length,
        })

        await Promise.all(
          created.map((repo) =>
            step.runWorkflow(repositoryIngestion.spec, {
              repositoryId: repo.id,
              orgId: repo.orgId,
            }),
          ),
        )
        logger.info("github repository sync queued ingestion workflows", {
          queuedWorkflowCount: created.length,
        })

        return { orgId: input.orgId, createdCount: created.length }
      },
    ),
)
