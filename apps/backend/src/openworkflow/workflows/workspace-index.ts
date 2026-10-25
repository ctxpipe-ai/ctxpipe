import { z } from "zod"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { startFirstOrgIngestion } from "../../domain/workspace-sources/first-ingestion.js"
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
      // copy of its own. It is ready when that checkout exists. With no
      // checkout, it starts the ingestion of the repository; an ingestion
      // that runs already absorbs the request. When that ingestion
      // publishes, it queues this index again.
      const hasCheckout = await step.run({ name: "published-checkout" }, () =>
        hasPublishedCheckout(repositoryId),
      )
      if (!hasCheckout)
        await step.run({ name: "start-ingestion" }, async () => {
          await startFirstOrgIngestion({
            orgId: input.orgId,
            repository: { id: repositoryId, ingested: false },
            step: "workspace_index.enqueue_ingestion",
          })
          return { requested: true }
        })
      return withOrgDbContext(input.orgId, async () => {
        if (linked) {
          if (!hasCheckout)
            return {
              published: false,
              reason: "no_published_checkout" as const,
            }
          return {
            published: await persistLinkedIndexedSha(linked),
            role: "linked" as const,
          }
        }
        const published = await persistWorkspaceIndexResult({
          revision,
          result: hasCheckout
            ? { kind: "ready" }
            : {
                kind: "failed",
                message:
                  "Code search has no copy of this repository yet. An ingestion of the repository started; the Workspace index runs again when it finishes. If it does not, start an ingestion of the repository.",
              },
        })
        return {
          published: hasCheckout && published,
          role: "workspace" as const,
        }
      })
    })
  },
)
