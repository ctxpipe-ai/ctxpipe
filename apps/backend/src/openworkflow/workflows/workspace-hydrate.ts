import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { embedHydrateUnits } from "../../domain/workspaces/derived-stores.js"
import { projectWorkspaceGraph } from "../../domain/workspaces/graph-projection.js"
import {
  applyEffectiveValidFromToUnits,
  displayNameFromAgentsMarkdown,
  hydrateKnowledgeTree,
} from "../../domain/workspaces/hydrate.js"
import {
  resolveRepositoryReadCredential,
  resolveWorkspaceReadRevision,
} from "../../domain/workspaces/resolve-revision.js"
import {
  linkedRevisionSchema,
  publishedProjection,
  sameWorkspaceRevision,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  commitHydrateProjection,
  getLinkedReadBinding,
  getWorkspaceProjectionSnapshot,
  listLinkedRepositories,
  persistEmbeddingFailure,
  persistHydrateFailure,
  persistUnitEmbeddings,
} from "../../models/workspaces.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { generateEmbeddings } from "../../retrieval/services/modelProvider.js"
import { listMarkdownFilesAtGitSha } from "../../services/git/clone-tree.js"
import { enqueueWorkspaceIndex } from "../enqueue-workspace-index.js"

const workspaceHydrateInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    revision: workspaceRevisionSchema,
  })
  .strict()
  .refine(
    (input) => input.revision.workspaceId === input.workspaceId,
    "A bound hydrate input must contain its matching revision",
  )

async function enqueueLaggingIndex(input: {
  orgId: string
  revision: WorkspaceRevision
}): Promise<void> {
  const linked = await withOrgDbContext(input.orgId, () =>
    listLinkedRepositories(input.revision.workspaceId),
  )
  const log = getLogger()
  await enqueueWorkspaceIndex(
    { orgId: input.orgId, revision: input.revision },
    { error: (err) => log.error(err) },
  )
  for (const row of linked) {
    if (!row.desiredSha || row.desiredSha === row.indexedSha) continue
    const binding = await withOrgDbContext(input.orgId, () =>
      getLinkedReadBinding(row.id),
    )
    if (!binding?.sha || !sameWorkspaceRevision(binding.owner, input.revision))
      continue
    await enqueueWorkspaceIndex(
      {
        orgId: input.orgId,
        revision: input.revision,
        linked: linkedRevisionSchema.parse(binding),
      },
      { error: (err) => log.error(err) },
    )
  }
}

export const workspaceHydrate = defineWorkflow(
  { name: "workspace-hydrate", schema: workspaceHydrateInputSchema },
  async ({ input: queuedInput }) => {
    // OpenWorkflow validates enqueue, but persisted pre-upgrade runs reach the worker directly.
    const input = workspaceHydrateInputSchema.parse(queuedInput)
    return withLogger(
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
          let failingRevision: WorkspaceRevision | undefined = input.revision
          try {
            const resolved = await resolveWorkspaceReadRevision({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              env,
              expected: input.revision,
            })
            if (!resolved)
              return { hydrated: false, reason: "cas_discarded" as const }
            const { revision, token, workspace } = resolved
            failingRevision = revision
            const desiredSha = revision.sha
            const snapshot = await getWorkspaceProjectionSnapshot(workspace.id)
            const projection = publishedProjection(snapshot.projection)
            const active =
              projection?.kind === "active" &&
              sameWorkspaceRevision(projection.revision, revision)
                ? projection
                : null
            const pending = {
              postgres: !active,
              embeddings: !active || active.stores.embeddings.kind !== "ready",
              index: !active || active.stores.index.kind !== "ready",
              graph: !active || active.stores.graph.kind !== "ready",
            }
            if (
              !pending.postgres &&
              !pending.embeddings &&
              !pending.index &&
              !pending.graph
            )
              return { hydrated: false, reason: "noop" as const }
            if (
              pending.index &&
              !pending.postgres &&
              !pending.embeddings &&
              !pending.graph
            ) {
              await enqueueLaggingIndex({
                orgId: input.orgId,
                revision,
              })
              return { hydrated: false, reason: "index_lag" as const }
            }

            const files = pending.postgres
              ? await listMarkdownFilesAtGitSha({
                  includeIntroducingCommits: true,
                  url: revision.remote.url,
                  sha: revision.sha,
                  token:
                    token ??
                    (await resolveRepositoryReadCredential({
                      orgId: input.orgId,
                      env,
                      remote: revision.remote,
                    })),
                })
              : []

            const parsed = pending.postgres
              ? hydrateKnowledgeTree({
                  workspaceId: workspace.id,
                  files,
                })
              : { units: snapshot.units, linked: [], skipped: [] }
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
            if (pending.postgres) {
              activated = await orgSql(() =>
                commitHydrateProjection({
                  orgId: input.orgId,
                  revision,
                  displayName,
                  remotes: parsed.linked,
                  units: applyEffectiveValidFromToUnits(
                    parsed.units,
                    new Map(
                      files.flatMap((file) =>
                        file.introducingCommitTimestamp
                          ? [
                              [
                                file.path,
                                file.introducingCommitTimestamp,
                              ] as const,
                            ]
                          : [],
                      ),
                    ),
                  ),
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
            }

            if (activated && pending.graph) {
              try {
                await projectWorkspaceGraph(revision)
              } catch (error) {
                log.error(
                  error instanceof Error ? error : new Error(String(error)),
                )
              }
            }

            if (activated && pending.embeddings) {
              try {
                const embeddings = await embedHydrateUnits({
                  units: parsed.units,
                  embed: generateEmbeddings,
                })
                await persistUnitEmbeddings({ revision, embeddings })
              } catch (error) {
                log.error(
                  error instanceof Error
                    ? error
                    : new Error("hydrate embeddings failed"),
                )
                await persistEmbeddingFailure({
                  revision,
                  message:
                    error instanceof Error ? error.message : String(error),
                })
              }
            }

            if (pending.index) {
              await enqueueLaggingIndex({
                orgId: input.orgId,
                revision,
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
              if (failingRevision)
                await orgSql(() =>
                  persistHydrateFailure({
                    revision: failingRevision as WorkspaceRevision,
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
    )
  },
)
