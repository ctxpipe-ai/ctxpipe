import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { embedHydrateUnits } from "../../domain/workspaces/derived-stores.js"
import {
  applyEffectiveValidFromToUnits,
  displayNameFromAgentsMarkdown,
  hydrateKnowledgeTree,
  hydrateReadPlan,
  hydrateReadsStoredDesiredSha,
} from "../../domain/workspaces/hydrate.js"
import {
  type HydratePhaseRecord,
  hydrateHasPendingWork,
  initialHydratePhases,
  markHydratePhase,
  pendingHydratePhases,
} from "../../domain/workspaces/hydrate-phases.js"
import { workspaceIndexJobs } from "../../domain/workspaces/revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  commitHydrateProjection,
  getWorkspaceById,
  listLinkedRepositories,
  persistHydrateFailure,
  persistHydratePhases,
  persistUnitEmbeddings,
} from "../../models/workspaces.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { generateEmbeddings } from "../../retrieval/services/modelProvider.js"
import { listMarkdownFilesAtGitSha } from "../../services/git/clone-tree.js"
import {
  getFileContent,
  listFilesAtSha,
} from "../../services/github/installation-write-client.js"
import { enqueueWorkspaceIndex } from "../enqueue-workspace-index.js"

const workspaceHydrateInputSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  generation: z.number().int().optional(),
  url: z.string().min(1).optional(),
  sha: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
})

async function enqueueLaggingIndex(input: {
  orgId: string
  workspaceId: string
  workspaceRepositoryUrl: string
  desiredGeneration: number
  desiredSha: string | null
  indexedSha: string | null
}): Promise<void> {
  const linked = await withOrgDbContext(input.orgId, () =>
    listLinkedRepositories(input.workspaceId),
  )
  const log = getLogger()
  for (const job of workspaceIndexJobs({
    workspaceId: input.workspaceId,
    workspaceRepositoryUrl: input.workspaceRepositoryUrl,
    desiredGeneration: input.desiredGeneration,
    desiredSha: input.desiredSha,
    indexedSha: input.indexedSha,
    linked,
  })) {
    try {
      await enqueueWorkspaceIndex(
        { orgId: input.orgId, ...job },
        { error: (err) => log.error(err) },
      )
    } catch (error) {
      log.error(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

export const workspaceHydrate = defineWorkflow(
  { name: "workspace-hydrate", schema: workspaceHydrateInputSchema },
  async ({ input }) =>
    withLogger(
      createLogger({
        workflow: "workspace-hydrate",
        orgId: input.orgId,
        workspaceId: input.workspaceId,
      }),
      async () => {
        const env = parseEnv(process.env as Record<string, string | undefined>)
        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })
        if (!org) throw new Error(`Organization not found: ${input.orgId}`)

        return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
          const orgSql = <T>(fn: () => Promise<T>) =>
            withOrgDbContext(input.orgId, fn)
          try {
            const loaded = await orgSql(() =>
              getWorkspaceById(input.workspaceId),
            )
            if (!loaded) throw new Error("Workspace not found")
            const workspace = loaded
            void input.defaultBranch
            const desiredSha = input.sha ?? workspace.desiredSha
            if (!desiredSha) {
              throw new Error(
                "Could not resolve the git tip for this workspace repository.",
              )
            }
            const pending = pendingHydratePhases({
              desiredUrl: workspace.workspaceRepositoryUrl,
              desiredSha,
              activeProjectionUrl: workspace.activeProjectionUrl,
              activeProjectionSha: workspace.activeProjectionSha,
              indexedSha: workspace.indexedSha,
              phases: workspace.hydratePhases,
            })
            if (!hydrateHasPendingWork(pending)) {
              return { hydrated: false, reason: "noop" as const }
            }
            if (pending.index && !pending.postgres && !pending.embeddings) {
              await enqueueLaggingIndex({
                orgId: input.orgId,
                workspaceId: workspace.id,
                workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
                desiredGeneration: workspace.desiredGeneration,
                desiredSha,
                indexedSha: workspace.indexedSha,
              })
              return { hydrated: false, reason: "index_lag" as const }
            }

            const repoName = githubRepoFullNameFromWorkspaceUrl(
              workspace.workspaceRepositoryUrl,
            )
            const treeSha = hydrateReadsStoredDesiredSha(desiredSha)
            if (!treeSha) {
              throw new Error(
                "Could not resolve the git tip for this workspace repository.",
              )
            }
            const files: Array<{ path: string; content: string }> = []
            if (
              hydrateReadPlan(
                workspace.workspaceRepositoryUrl,
                workspace.githubConnectionId,
              ).via === "github" &&
              repoName
            ) {
              const tree = await listFilesAtSha({
                orgId: input.orgId,
                repositoryName: repoName,
                env,
                githubConnectionId: workspace.githubConnectionId ?? undefined,
                sha: treeSha,
              })
              for (const entry of tree) {
                if (!entry.path.endsWith(".md")) continue
                const content = await getFileContent({
                  orgId: input.orgId,
                  repositoryName: repoName,
                  env,
                  githubConnectionId: workspace.githubConnectionId ?? undefined,
                  branch: treeSha,
                  path: entry.path,
                })
                if (content == null) continue
                files.push({ path: entry.path, content })
              }
            } else {
              files.push(
                ...(await listMarkdownFilesAtGitSha({
                  url: workspace.workspaceRepositoryUrl,
                  sha: treeSha,
                })),
              )
            }

            const parsed = hydrateKnowledgeTree({
              workspaceId: workspace.id,
              files,
            })
            const agents = files.find((file) => file.path === "AGENTS.md")
            const displayName = agents
              ? displayNameFromAgentsMarkdown(agents.content)
              : null
            const log = getLogger()
            log.set({
              workspaceId: workspace.id,
              desiredSha,
            })

            let activated = !pending.postgres
            let phases: HydratePhaseRecord =
              workspace.hydratePhases?.url ===
                workspace.workspaceRepositoryUrl &&
              workspace.hydratePhases.sha === desiredSha
                ? workspace.hydratePhases
                : initialHydratePhases({
                    url: workspace.workspaceRepositoryUrl,
                    sha: desiredSha,
                  })
            if (pending.postgres) {
              activated = await orgSql(() =>
                commitHydrateProjection({
                  orgId: input.orgId,
                  workspaceId: workspace.id,
                  jobGeneration: workspace.desiredGeneration,
                  jobWorkspaceUrl: workspace.workspaceRepositoryUrl,
                  hydratedSha: desiredSha,
                  displayName,
                  remotes: parsed.linked,
                  units: applyEffectiveValidFromToUnits(parsed.units, null),
                }),
              )
              if (!activated) {
                return {
                  hydrated: false,
                  reason: "cas_discarded" as const,
                  units: parsed.units.length,
                  skipped: parsed.skipped.length,
                }
              }
              phases = initialHydratePhases({
                url: workspace.workspaceRepositoryUrl,
                sha: desiredSha,
              })
            }

            if (activated && pending.embeddings) {
              try {
                const embeddings = await embedHydrateUnits({
                  units: parsed.units,
                  embed: generateEmbeddings,
                })
                phases = markHydratePhase(phases, "embeddings")
                await orgSql(async () => {
                  await persistUnitEmbeddings({
                    workspaceId: workspace.id,
                    projectionSha: desiredSha,
                    embeddings,
                  })
                  await persistHydratePhases({
                    workspaceId: workspace.id,
                    expectedUrl: workspace.workspaceRepositoryUrl,
                    expectedSha: desiredSha,
                    phases,
                  })
                })
              } catch (error) {
                log.error(
                  error instanceof Error
                    ? error
                    : new Error("hydrate embeddings failed"),
                )
              }
            }

            if (pending.index) {
              await enqueueLaggingIndex({
                orgId: input.orgId,
                workspaceId: workspace.id,
                workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
                desiredGeneration: workspace.desiredGeneration,
                desiredSha,
                indexedSha: workspace.indexedSha,
              })
            }

            return {
              hydrated: activated,
              units: parsed.units.length,
              skipped: parsed.skipped.length,
              diagnostics: parsed.skipped,
            }
          } catch (error) {
            try {
              await orgSql(() =>
                persistHydrateFailure({
                  workspaceId: input.workspaceId,
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
              )
            } catch {
              // Persist is best-effort; OpenWorkflow still records the failed run.
            }
            throw error
          }
        })
      },
    ),
)
