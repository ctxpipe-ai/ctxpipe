import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  embedHydrateUnits,
  workspaceGraphProjectionScope,
} from "../../domain/workspaces/derived-stores.js"
import {
  applyEffectiveValidFromToUnits,
  displayNameFromAgentsMarkdown,
  hydrateKnowledgeTree,
  hydrateReadPlan,
  hydrateReadsStoredDesiredSha,
  hydrateUnitsToProjectionClaims,
} from "../../domain/workspaces/hydrate.js"
import {
  type HydratePhaseRecord,
  hydrateHasPendingWork,
  initialHydratePhases,
  markHydratePhase,
  pendingHydratePhases,
} from "../../domain/workspaces/hydrate-phases.js"
import {
  extractIngestRemainder,
  hydrateWriteJobRemainders,
  hydrateWriteJobsToEnqueue,
  kindsToRetryAfterHydrate,
} from "../../domain/workspaces/hydrate-write-jobs.js"
import { planMigrationExport } from "../../domain/workspaces/migration-export.js"
import { workspaceIndexJobs } from "../../domain/workspaces/revision.js"
import { kindsWithinRetryCap } from "../../domain/workspaces/write-jobs.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { loadMigrationExportSource } from "../../models/workspace-export.js"
import {
  commitHydrateProjection,
  countWriteJobAttempts,
  getWorkspaceById,
  listLinkedRepositories,
  listWorkspaceKnowledgeUnits,
  persistHydrateFailure,
  persistHydratePhases,
  persistResolvedDesiredSha,
  persistUnitEmbeddings,
} from "../../models/workspaces.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { projectClaimsFromState } from "../../retrieval/services/graphProjection.js"
import { generateEmbeddings } from "../../retrieval/services/modelProvider.js"
import { resolveWorkspaceRepositoryTip } from "../../routes/webhooks/github/github-workspace-tip.js"
import { listMarkdownFilesAtGitSha } from "../../services/git/clone-tree.js"
import {
  getCommitTimestamp,
  getFileContent,
  listFilesAtSha,
} from "../../services/github/installation-write-client.js"
import { enqueueWorkspaceIndex } from "../enqueue-workspace-index.js"

const workspaceHydrateInputSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
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
  const linked = await listLinkedRepositories(input.workspaceId)
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

        return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
          withOrgDbContext(input.orgId, async () => {
            try {
              let workspace = await getWorkspaceById(input.workspaceId)
              if (!workspace) throw new Error("Workspace not found")
              void input.defaultBranch
              if (!workspace.desiredSha) {
                const tip = await resolveWorkspaceRepositoryTip({
                  orgId: input.orgId,
                  githubConnectionId: workspace.githubConnectionId,
                  workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
                  env,
                })
                if (!tip) {
                  throw new Error(
                    "Could not resolve the git tip for this workspace repository.",
                  )
                }
                await persistResolvedDesiredSha({
                  workspaceId: workspace.id,
                  resolvedTip: tip,
                  expectedGeneration: workspace.desiredGeneration,
                  expectedUrl: workspace.workspaceRepositoryUrl,
                  expectedDesiredSha: null,
                })
                workspace = { ...workspace, desiredSha: tip }
              }
              const desiredSha = workspace.desiredSha
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
              if (
                pending.index &&
                !pending.postgres &&
                !pending.embeddings &&
                !pending.graph &&
                !pending.remainders
              ) {
                await enqueueLaggingIndex({
                  orgId: input.orgId,
                  workspaceId: workspace.id,
                  workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
                  desiredGeneration: workspace.desiredGeneration,
                  desiredSha: workspace.desiredSha,
                  indexedSha: workspace.indexedSha,
                })
                return { hydrated: false, reason: "index_lag" as const }
              }

              const repoName = githubRepoFullNameFromWorkspaceUrl(
                workspace.workspaceRepositoryUrl,
              )
              const treeSha = hydrateReadsStoredDesiredSha(workspace.desiredSha)
              if (!treeSha) {
                throw new Error(
                  "Could not resolve the git tip for this workspace repository.",
                )
              }
              const files: Array<{ path: string; content: string }> = []
              if (
                hydrateReadPlan(workspace.workspaceRepositoryUrl).via ===
                  "github" &&
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
                    githubConnectionId:
                      workspace.githubConnectionId ?? undefined,
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
              const previous = await listWorkspaceKnowledgeUnits(workspace.id)
              const previousPaths = previous.units.map((unit) => unit.path)
              const agents = files.find((file) => file.path === "AGENTS.md")
              const displayName = agents
                ? displayNameFromAgentsMarkdown(agents.content)
                : null
              const github = repoName
                ? {
                    orgId: input.orgId,
                    repositoryName: repoName,
                    env,
                    githubConnectionId:
                      workspace.githubConnectionId ?? undefined,
                  }
                : null
              const introducingCommitTimestamp = github
                ? await getCommitTimestamp({ ...github, sha: treeSha })
                : null
              const log = getLogger()
              log.set({
                workspaceId: workspace.id,
                desiredSha: workspace.desiredSha,
              })

              let activated = !pending.postgres
              let phases: HydratePhaseRecord =
                workspace.hydratePhases?.url ===
                  workspace.workspaceRepositoryUrl &&
                workspace.hydratePhases.sha === workspace.desiredSha
                  ? workspace.hydratePhases
                  : initialHydratePhases({
                      url: workspace.workspaceRepositoryUrl,
                      sha: workspace.desiredSha,
                    })
              if (pending.postgres) {
                activated = await commitHydrateProjection({
                  orgId: input.orgId,
                  workspaceId: workspace.id,
                  jobGeneration: workspace.desiredGeneration,
                  jobWorkspaceUrl: workspace.workspaceRepositoryUrl,
                  hydratedSha: workspace.desiredSha,
                  displayName,
                  remotes: parsed.linked,
                  units: applyEffectiveValidFromToUnits(
                    parsed.units,
                    introducingCommitTimestamp,
                  ),
                })
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
                  sha: workspace.desiredSha,
                })
              }

              if (activated && pending.embeddings) {
                try {
                  const embeddings = await embedHydrateUnits({
                    units: parsed.units,
                    embed: generateEmbeddings,
                  })
                  await persistUnitEmbeddings({
                    workspaceId: workspace.id,
                    projectionSha: workspace.desiredSha,
                    embeddings,
                  })
                  phases = markHydratePhase(phases, "embeddings")
                  await persistHydratePhases({
                    workspaceId: workspace.id,
                    expectedUrl: workspace.workspaceRepositoryUrl,
                    expectedSha: workspace.desiredSha,
                    phases,
                  })
                } catch (error) {
                  log.error(
                    error instanceof Error
                      ? error
                      : new Error("hydrate embeddings failed"),
                  )
                }
              }

              if (activated && pending.graph) {
                try {
                  const graphClaims = hydrateUnitsToProjectionClaims(
                    parsed.units,
                    introducingCommitTimestamp,
                  )
                  await projectClaimsFromState(
                    graphClaims,
                    workspaceGraphProjectionScope({
                      workspaceId: workspace.id,
                      projectionSha: workspace.desiredSha,
                    }),
                  )
                  phases = markHydratePhase(phases, "graph")
                  await persistHydratePhases({
                    workspaceId: workspace.id,
                    expectedUrl: workspace.workspaceRepositoryUrl,
                    expectedSha: workspace.desiredSha,
                    phases,
                  })
                } catch (error) {
                  log.error(
                    error instanceof Error
                      ? error
                      : new Error("hydrate graph failed"),
                  )
                }
              }

              if (pending.index) {
                await enqueueLaggingIndex({
                  orgId: input.orgId,
                  workspaceId: workspace.id,
                  workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
                  desiredGeneration: workspace.desiredGeneration,
                  desiredSha: workspace.desiredSha,
                  indexedSha: workspace.indexedSha,
                })
              }

              if (activated && pending.remainders) {
                try {
                  const linked = await listLinkedRepositories(workspace.id)
                  const exportSource = await loadMigrationExportSource()
                  const exportPlan = planMigrationExport({
                    workspaceId: workspace.id,
                    firstWorkspaceId: exportSource.firstWorkspaceId,
                    workspaceByRepositoryId:
                      exportSource.workspaceByRepositoryId,
                    objects: exportSource.objects,
                    claims: exportSource.claims,
                    existingKnowledge: files,
                    linkedUrls: linked.map((row) => row.gitUrl),
                  })
                  const extractRemainder = extractIngestRemainder({
                    proposed: exportPlan.files,
                    existing: new Map(
                      files.map((file) => [file.path, file.content]),
                    ),
                  })
                  const remaining = hydrateWriteJobsToEnqueue({
                    units: parsed.units,
                    agentsMd: agents?.content ?? null,
                    writeStatus: workspace.writeStatus,
                    jobGeneration: workspace.desiredGeneration,
                    desiredGeneration: workspace.desiredGeneration,
                    previousPaths,
                    extractRemainder,
                  })
                  const remainderAfter = hydrateWriteJobRemainders({
                    units: parsed.units,
                    agentsMd: agents?.content ?? null,
                    previousPaths,
                    extractRemainder,
                  })
                  const remainderBefore = hydrateWriteJobRemainders({
                    units: previous.units,
                    agentsMd: null,
                    previousPaths: [],
                    extractRemainder: 0,
                  })
                  const attemptsForSha: Record<string, number> = {}
                  for (const kind of remaining) {
                    attemptsForSha[kind] = await countWriteJobAttempts({
                      workspaceId: workspace.id,
                      kind,
                      desiredSha: workspace.desiredSha,
                    })
                  }
                  const retryable = kindsWithinRetryCap({
                    kinds: kindsToRetryAfterHydrate({
                      remaining,
                      remainderBefore,
                      remainderAfter,
                      attemptsForSha,
                    }),
                    attemptsForSha,
                  })
                  if (retryable.length > 0) {
                    const { enqueueWorkspaceWriteCommit } = await import(
                      "../enqueue-workspace-write-commit.js"
                    )
                    let enqueueFailed = false
                    for (const kind of retryable) {
                      await enqueueWorkspaceWriteCommit(
                        {
                          orgId: input.orgId,
                          workspaceId: workspace.id,
                          kind,
                        },
                        {
                          error: (err) => {
                            enqueueFailed = true
                            log.error(err)
                          },
                        },
                      )
                    }
                    if (enqueueFailed) {
                      throw new Error("hydrate remainder enqueue failed")
                    }
                  }
                  phases = markHydratePhase(phases, "remainders")
                  await persistHydratePhases({
                    workspaceId: workspace.id,
                    expectedUrl: workspace.workspaceRepositoryUrl,
                    expectedSha: workspace.desiredSha,
                    phases,
                  })
                } catch (error) {
                  log.error(
                    error instanceof Error
                      ? error
                      : new Error("hydrate remainder enqueue failed"),
                  )
                }
              }

              return {
                hydrated: activated,
                units: parsed.units.length,
                skipped: parsed.skipped.length,
              }
            } catch (error) {
              try {
                await persistHydrateFailure({
                  workspaceId: input.workspaceId,
                  message:
                    error instanceof Error ? error.message : String(error),
                })
              } catch {
                // Persist is best-effort; OpenWorkflow still records the failed run.
              }
              throw error
            }
          }),
        )
      },
    ),
)
