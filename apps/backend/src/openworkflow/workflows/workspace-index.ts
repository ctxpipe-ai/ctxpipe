import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  linkedRevisionSchema,
  sameLinkedReadBinding,
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  findRepositoriesByNormalizedGitUrls,
  hasPublishedCheckout,
} from "../../models/repositories.js"
import {
  getDesiredWorkspaceRevision,
  getLinkedReadBinding,
  persistLinkedIndexedSha,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

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
      // Workspace code reads use the published checkout of the repository
      // (the newest commit of its default branch), so this run makes no
      // copy of its own. It is ready when that checkout exists.
      const searchIndexOk = await step.run({ name: "published-checkout" }, () =>
        hasPublishedCheckout(repositoryId),
      )
      return withOrgDbContext(input.orgId, async () => {
        if (linked) {
          if (!searchIndexOk)
            return { published: false, reason: "search_index_failed" as const }
          return {
            published: await persistLinkedIndexedSha(linked),
            role: "linked" as const,
          }
        }
        const published = await persistWorkspaceIndexResult({
          revision,
          result: searchIndexOk
            ? { kind: "ready" }
            : {
                kind: "failed",
                message:
                  "Code search has no copy of this repository yet. Start an ingestion of the repository, then index the Workspace again.",
              },
        })
        return {
          published: searchIndexOk && published,
          role: "workspace" as const,
        }
      })
    })
  },
)
