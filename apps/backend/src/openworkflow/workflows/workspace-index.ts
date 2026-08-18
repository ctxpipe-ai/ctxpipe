import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { HYDRATE_INDEX_UNAVAILABLE_MESSAGE } from "../../domain/workspaces/hydrate.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  ensureWorkspaceCheckout,
  findRepositoriesByNormalizedGitUrls,
  getGithubConnectionIdForRepository,
} from "../../models/repositories.js"
import {
  getWorkspaceById,
  listLinkedRepositories,
  persistHydrateFailure,
  persistIndexedSha,
  persistLinkedIndexedSha,
} from "../../models/workspaces.js"
import { repositoryIndex } from "./repository-index.js"

const workspaceIndexInputSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  gitUrl: z.string().min(1),
  desiredSha: z.string().min(1),
  role: z.enum(["workspace", "linked"]),
  linkedId: z.string().min(1).optional(),
  jobGeneration: z.number().int(),
  jobWorkspaceUrl: z.string().min(1),
})

export const workspaceIndex = defineWorkflow(
  { name: "workspace-index", schema: workspaceIndexInputSchema },
  async ({ input, step }) => {
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) throw new Error(`Organization not found: ${input.orgId}`)

    return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
      const prepared = await withOrgDbContext(input.orgId, async () => {
        const workspace = await getWorkspaceById(input.workspaceId)
        if (!workspace) {
          return { kind: "done" as const, result: { published: false, reason: "missing" as const } }
        }
        const repos = await findRepositoriesByNormalizedGitUrls([
          normalizeWorkspaceRepositoryUrl(input.gitUrl),
        ])
        const repo = repos[0]
        if (!repo) {
          if (!workspace.activeProjectionSha) {
            await persistHydrateFailure({
              workspaceId: workspace.id,
              message: HYDRATE_INDEX_UNAVAILABLE_MESSAGE,
            })
          }
          return {
            kind: "done" as const,
            result: { published: false, reason: "no_repository" as const },
          }
        }
        const githubConnectionId =
          (await getGithubConnectionIdForRepository({
            orgId: input.orgId,
            repositoryId: repo.id,
          })) ??
          workspace.githubConnectionId ??
          null
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

      try {
        await step.runWorkflow(
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
          },
          { name: "repository-index" },
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        if (
          !prepared.workspace.activeProjectionSha &&
          message.includes("clone-checkout failed with status 404")
        ) {
          await withOrgDbContext(input.orgId, () =>
            persistHydrateFailure({
              workspaceId: prepared.workspace.id,
              message: HYDRATE_INDEX_UNAVAILABLE_MESSAGE,
            }),
          )
        }
        throw err
      }

      return withOrgDbContext(input.orgId, async () => {
        if (input.role === "linked" && input.linkedId) {
          const linked = (await listLinkedRepositories(prepared.workspace.id)).find(
            (row) => row.id === input.linkedId,
          )
          if (!linked) {
            return { published: false, reason: "missing_linked" as const }
          }
          const published = await persistLinkedIndexedSha({
            linkedId: input.linkedId,
            workspaceId: prepared.workspace.id,
            indexedSha: input.desiredSha,
            expectedDesiredSha: input.desiredSha,
            expectedGeneration: input.jobGeneration,
            expectedWorkspaceUrl: input.jobWorkspaceUrl,
            expectedLinkedUrl: linked.gitUrl,
            expectedLinkedRef: linked.desiredRef,
          })
          return { published, role: input.role }
        }
        const published = await persistIndexedSha({
          workspaceId: prepared.workspace.id,
          indexedSha: input.desiredSha,
          expectedGeneration: input.jobGeneration,
          expectedUrl: input.jobWorkspaceUrl,
          expectedDesiredSha: input.desiredSha,
        })
        return { published, role: input.role }
      })
    })
  },
)
