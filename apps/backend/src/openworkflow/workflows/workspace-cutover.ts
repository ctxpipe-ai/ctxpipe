import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import {
  firstConnectorTarget,
  planVersionStartCutover,
  workspacesNeedingMigrationExport,
} from "../../domain/workspaces/migration-cutover.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { listConnectorTargetRepositories } from "../../models/connector-sync-target.js"
import {
  createCutoverWorkspace,
  getPersistedFirstWorkspaceId,
  listCompletedMigrationExportWorkspaceIds,
  listOrgWorkspaces,
  persistFirstWorkspaceId,
} from "../../models/workspaces.js"
import { enqueueWorkspaceWriteCommit } from "../enqueue-workspace-write-commit.js"

const workspaceCutoverInputSchema = z.object({
  orgId: z.string().min(1),
})

export const workspaceCutover = defineWorkflow(
  { name: "workspace-cutover", schema: workspaceCutoverInputSchema },
  async ({ input }) => {
    const org = await getSystemDb().query.organizations.findFirst({
      where: { id: { eq: input.orgId } },
    })
    if (!org) throw new Error(`Organization not found: ${input.orgId}`)

    return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
      withOrgDbContext(input.orgId, async () => {
        const targets = await listConnectorTargetRepositories(input.orgId)
        const existing = await listOrgWorkspaces(input.orgId)
        const persistedFirst = await getPersistedFirstWorkspaceId(input.orgId)
        const plan = planVersionStartCutover({
          connectorTargets: targets,
          existingWorkspaceUrls: existing.map(
            (row) => row.workspaceRepositoryUrl,
          ),
          persistedFirstWorkspaceId: persistedFirst,
          normalizeUrl: normalizeWorkspaceRepositoryUrl,
        })
        const created: string[] = []
        for (const url of plan.urlsToCreate) {
          const target = targets.find(
            (row) => normalizeWorkspaceRepositoryUrl(row.gitUrl) === url,
          )
          const workspace = await createCutoverWorkspace({
            gitUrl: url,
            displayName: target?.name,
            githubConnectionId: target?.githubConnectionId,
          })
          created.push(workspace.id)
        }
        const afterCreate = await listOrgWorkspaces(input.orgId)
        const targetUrls = new Set(
          targets.map((row) => normalizeWorkspaceRepositoryUrl(row.gitUrl)),
        )
        const targetWorkspaces = afterCreate.filter((row) =>
          targetUrls.has(
            normalizeWorkspaceRepositoryUrl(row.workspaceRepositoryUrl),
          ),
        )
        if (plan.persistFirst) {
          const first = firstConnectorTarget(targetWorkspaces)
          if (first) await persistFirstWorkspaceId(first.id, input.orgId)
        }
        let exports = 0
        if (plan.enqueueExports) {
          const completed = await listCompletedMigrationExportWorkspaceIds()
          const pendingIds = new Set(
            workspacesNeedingMigrationExport({
              workspaces: targetWorkspaces,
              completedExportWorkspaceIds: completed,
            }),
          )
          for (const workspace of targetWorkspaces) {
            if (!pendingIds.has(workspace.id)) continue
            exports += 1
            void enqueueWorkspaceWriteCommit(
              {
                orgId: input.orgId,
                workspaceId: workspace.id,
                kind: "migration_export",
              },
              { error: () => undefined },
            )
          }
        }
        return {
          created: created.length,
          exports,
        }
      }),
    )
  },
)
