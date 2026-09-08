import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  linkedRevisionSchema,
  sameLinkedReadBinding,
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  ensureWorkspaceCheckout,
  findRepositoriesByNormalizedGitUrls,
} from "../../models/repositories.js"
import {
  getDesiredWorkspaceRevision,
  getLinkedReadBinding,
  persistLinkedIndexedSha,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import { repositoryIndex } from "./repository-index.js"

export const workspaceIndexInputSchema = z
  .object({
    orgId: z.string().min(1),
    revision: workspaceRevisionSchema,
    linked: linkedRevisionSchema.optional(),
  })
  .refine(
    (input) =>
      input.revision.access === "read" &&
      (!input.linked ||
        sameWorkspaceRevision(input.linked.owner, input.revision)),
    "Index input must describe one captured owner revision",
  )

export const workspaceIndex = defineWorkflow(
  { name: "workspace-index", schema: workspaceIndexInputSchema },
  async ({ input, step }) => {
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) throw new Error(`Organization not found: ${input.orgId}`)
    return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
      const { revision, linked } = input
      if (
        !sameWorkspaceRevision(
          await getDesiredWorkspaceRevision(revision.workspaceId),
          revision,
        )
      )
        return { published: false, reason: "cas_discarded" as const }
      if (
        linked &&
        !sameLinkedReadBinding(
          await getLinkedReadBinding(linked.linkId),
          linked,
        )
      )
        return { published: false, reason: "cas_discarded" as const }
      const target = linked ?? revision
      const repositoryId =
        linked?.repositoryId ??
        (
          await findRepositoriesByNormalizedGitUrls([
            normalizeWorkspaceRepositoryUrl(target.remote.url),
          ])
        )[0]?.id
      if (!repositoryId) {
        if (!linked)
          await persistWorkspaceIndexResult({
            revision,
            result: {
              kind: "failed",
              message: "Workspace repository is unavailable for indexing",
            },
          })
        return { published: false, reason: "no_repository" as const }
      }
      await ensureWorkspaceCheckout({
        repositoryId,
        workspaceId: revision.workspaceId,
        ref: target.sha,
      })
      const indexed = await step.runWorkflow(
        repositoryIndex.spec,
        {
          repositoryId,
          orgId: input.orgId,
          targetHash: target.sha,
          workspaceId: revision.workspaceId,
          ...(linked ? { linkedRevision: linked } : { revision }),
        },
        { name: "repository-index" },
      )
      return withOrgDbContext(input.orgId, async () => {
        if (linked) {
          if (!indexed.searchIndexOk)
            return { published: false, reason: "search_index_failed" as const }
          return {
            published: await persistLinkedIndexedSha(linked),
            role: "linked" as const,
          }
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
          role: "workspace" as const,
        }
      })
    })
  },
)
