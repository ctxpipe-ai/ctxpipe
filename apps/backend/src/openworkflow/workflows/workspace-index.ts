import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  ensureWorkspaceCheckout,
  findRepositoriesByNormalizedGitUrls,
  getGithubConnectionIdForRepository,
} from "../../models/repositories.js"
import {
  getDesiredWorkspaceRevision,
  getWorkspaceById,
  listLinkedRepositories,
  persistLinkedIndexedSha,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import { repositoryIndex } from "./repository-index.js"

const workspaceIndexInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    gitUrl: z.string().min(1),
    desiredSha: z.string().min(1),
    role: z.enum(["workspace", "linked"]),
    linkedId: z.string().min(1).optional(),
    jobGeneration: z.number().int(),
    jobWorkspaceUrl: z.string().min(1),
    revision: workspaceRevisionSchema.optional(),
  })
  .refine(
    (input) => input.role !== "linked" || Boolean(input.linkedId),
    "Linked indexing requires a captured link identity",
  )
  .refine(
    (input) =>
      !input.revision ||
      (input.revision.access === "read" &&
        input.revision.workspaceId === input.workspaceId &&
        input.revision.generation === input.jobGeneration &&
        input.revision.remote.url === input.jobWorkspaceUrl &&
        (input.role === "linked" ||
          (input.revision.remote.url === input.gitUrl &&
            input.revision.sha === input.desiredSha))),
    "Index input must describe one workspace revision",
  )

export const workspaceIndex = defineWorkflow(
  { name: "workspace-index", schema: workspaceIndexInputSchema },
  async ({ input, step }) => {
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) throw new Error(`Organization not found: ${input.orgId}`)

    return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
      const revision = await getDesiredWorkspaceRevision(input.workspaceId)
      if (
        !revision ||
        (input.revision && !sameWorkspaceRevision(revision, input.revision)) ||
        revision.generation !== input.jobGeneration ||
        revision.remote.url !== input.jobWorkspaceUrl ||
        (input.role === "workspace" &&
          (revision.sha !== input.desiredSha ||
            revision.remote.url !== input.gitUrl))
      ) {
        return { published: false, reason: "cas_discarded" as const }
      }
      const linked =
        input.role === "linked"
          ? await step.run({ name: "capture-linked-revision" }, () =>
              withOrgDbContext(input.orgId, async () => {
                const row = (
                  await listLinkedRepositories(input.workspaceId)
                ).find((candidate) => candidate.id === input.linkedId)
                return row &&
                  row.gitUrl === input.gitUrl &&
                  row.desiredSha === input.desiredSha
                  ? {
                      id: row.id,
                      gitUrl: row.gitUrl,
                      desiredRef: row.desiredRef,
                      desiredSha: row.desiredSha,
                    }
                  : null
              }),
            )
          : null
      if (input.role === "linked" && !linked)
        return { published: false, reason: "missing_linked" as const }
      const prepared = await withOrgDbContext(input.orgId, async () => {
        const workspace = await getWorkspaceById(input.workspaceId)
        if (!workspace) {
          return {
            kind: "done" as const,
            result: { published: false, reason: "missing" as const },
          }
        }
        const repos = await findRepositoriesByNormalizedGitUrls([
          normalizeWorkspaceRepositoryUrl(input.gitUrl),
        ])
        const repo = repos[0]
        if (!repo) {
          if (input.role === "workspace")
            await persistWorkspaceIndexResult({
              revision,
              result: {
                kind: "failed",
                message: "Workspace repository is unavailable for indexing",
              },
            })
          return {
            kind: "done" as const,
            result: { published: false, reason: "no_repository" as const },
          }
        }
        const githubConnectionId =
          input.role === "workspace"
            ? revision.remote.githubConnectionId
            : await getGithubConnectionIdForRepository({
                orgId: input.orgId,
                repositoryId: repo.id,
              })
        await ensureWorkspaceCheckout({
          repositoryId: repo.id,
          workspaceId: workspace.id,
          ref: input.desiredSha,
        })
        return {
          kind: "index" as const,
          workspace,
          repo,
          githubConnectionId,
        }
      })

      if (prepared.kind === "done") return prepared.result

      const indexed = await step.runWorkflow(
        repositoryIndex.spec,
        {
          repositoryId: prepared.repo.id,
          orgId: input.orgId,
          targetHash: input.desiredSha,
          workspaceId: prepared.workspace.id,
          ...(prepared.githubConnectionId
            ? { githubConnectionId: prepared.githubConnectionId }
            : {}),
          jobGeneration: input.jobGeneration,
          jobWorkspaceUrl: input.jobWorkspaceUrl,
          ...(input.role === "workspace" ? { revision } : {}),
        },
        { name: "repository-index" },
      )

      return withOrgDbContext(input.orgId, async () => {
        if (input.role === "linked" && input.linkedId) {
          if (!indexed.searchIndexOk)
            return { published: false, reason: "search_index_failed" as const }
          if (!linked)
            return { published: false, reason: "missing_linked" as const }
          const published = await persistLinkedIndexedSha({
            linkedId: input.linkedId,
            revision,
            indexedSha: input.desiredSha,
            expectedDesiredSha: input.desiredSha,
            expectedLinkedUrl: linked.gitUrl,
            expectedLinkedRef: linked.desiredRef,
          })
          return { published, role: input.role }
        }
        const published = await persistWorkspaceIndexResult({
          revision,
          result: indexed.searchIndexOk
            ? { kind: "ready" }
            : {
                kind: "failed",
                message: indexed.searchIndexError ?? "Search index unavailable",
              },
        })
        return {
          published: indexed.searchIndexOk && published,
          role: input.role,
        }
      })
    })
  },
)
