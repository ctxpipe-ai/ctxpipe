import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { embedHydrateUnits } from "../../domain/workspaces/derived-stores.js"
import {
  displayNameFromAgentsMarkdown,
  hydrateIsNoop,
  hydrateKnowledgeTree,
  hydrateReadsStoredDesiredSha,
  hydrateUnitsToProjectionClaims,
} from "../../domain/workspaces/hydrate.js"
import {
  reconcileProjectionJobs,
  workspaceIndexJobs,
} from "../../domain/workspaces/revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  commitHydrateProjection,
  getWorkspaceById,
  listLinkedRepositories,
  persistUnitEmbeddings,
} from "../../models/workspaces.js"
import { projectClaimsFromState } from "../../retrieval/services/graphProjection.js"
import { generateEmbeddings } from "../../retrieval/services/modelProvider.js"
import {
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
  desiredSha: string | null
  indexedSha: string | null
}): Promise<void> {
  const linked = await listLinkedRepositories(input.workspaceId)
  for (const job of workspaceIndexJobs({
    workspaceId: input.workspaceId,
    workspaceRepositoryUrl: input.workspaceRepositoryUrl,
    desiredSha: input.desiredSha,
    indexedSha: input.indexedSha,
    linked,
  })) {
    void enqueueWorkspaceIndex(
      { orgId: input.orgId, ...job },
      { error: () => undefined },
    )
  }
}

export const workspaceHydrate = defineWorkflow(
  { name: "workspace-hydrate", schema: workspaceHydrateInputSchema },
  async ({ input }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) throw new Error(`Organization not found: ${input.orgId}`)

    return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
      withOrgDbContext(input.orgId, async () => {
        const workspace = await getWorkspaceById(input.workspaceId)
        if (!workspace) throw new Error("Workspace not found")
        void input.defaultBranch
        if (!workspace.desiredSha) {
          return { hydrated: false, reason: "desired_sha_missing" as const }
        }
        if (
          hydrateIsNoop(workspace.activeProjectionSha, workspace.desiredSha)
        ) {
          const jobs = reconcileProjectionJobs({
            desiredSha: workspace.desiredSha,
            desiredUrl: workspace.workspaceRepositoryUrl,
            activeProjectionUrl: workspace.activeProjectionUrl,
            activeProjectionSha: workspace.activeProjectionSha,
            indexedSha: workspace.indexedSha,
          })
          if (jobs.enqueueIndex) {
            await enqueueLaggingIndex({
              orgId: input.orgId,
              workspaceId: workspace.id,
              workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
              desiredSha: workspace.desiredSha,
              indexedSha: workspace.indexedSha,
            })
          }
          return { hydrated: false, reason: "noop" as const }
        }
        const repoName = githubRepoFullNameFromWorkspaceUrl(
          workspace.workspaceRepositoryUrl,
        )
        if (!repoName) {
          return { hydrated: false, reason: "not_github" as const }
        }
        const treeSha = hydrateReadsStoredDesiredSha(workspace.desiredSha)
        if (!treeSha) {
          return { hydrated: false, reason: "desired_sha_missing" as const }
        }
        const tree = await listFilesAtSha({
          orgId: input.orgId,
          repositoryName: repoName,
          env,
          githubConnectionId: workspace.githubConnectionId ?? undefined,
          sha: treeSha,
        })
        const files: Array<{ path: string; content: string }> = []
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

        const parsed = hydrateKnowledgeTree({
          workspaceId: workspace.id,
          files,
        })
        const agents = files.find((file) => file.path === "AGENTS.md")
        const displayName = agents
          ? displayNameFromAgentsMarkdown(agents.content)
          : null
        const activated = await commitHydrateProjection({
          orgId: input.orgId,
          workspaceId: workspace.id,
          jobGeneration: workspace.desiredGeneration,
          jobWorkspaceUrl: workspace.workspaceRepositoryUrl,
          hydratedSha: workspace.desiredSha,
          displayName,
          remotes: parsed.linked,
          units: parsed.units,
        })
        if (activated) {
          const embeddings = await embedHydrateUnits({
            units: parsed.units,
            embed: generateEmbeddings,
          })
          await persistUnitEmbeddings({
            workspaceId: workspace.id,
            projectionSha: workspace.desiredSha,
            embeddings,
          })
          const graphClaims = hydrateUnitsToProjectionClaims(parsed.units)
          if (graphClaims.length > 0) {
            try {
              await projectClaimsFromState(graphClaims)
            } catch {
              // Stale graph is ok; do not roll back hydrate.
            }
          }
          const jobs = reconcileProjectionJobs({
            desiredSha: workspace.desiredSha,
            desiredUrl: workspace.workspaceRepositoryUrl,
            activeProjectionUrl: workspace.workspaceRepositoryUrl,
            activeProjectionSha: workspace.desiredSha,
            indexedSha: workspace.indexedSha,
          })
          if (jobs.enqueueIndex) {
            await enqueueLaggingIndex({
              orgId: input.orgId,
              workspaceId: workspace.id,
              workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
              desiredSha: workspace.desiredSha,
              indexedSha: workspace.indexedSha,
            })
          }
        }
        return {
          hydrated: activated,
          units: parsed.units.length,
          skipped: parsed.skipped.length,
        }
      }),
    )
  },
)
