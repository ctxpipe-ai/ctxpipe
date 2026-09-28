import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import { linearAccessToken } from "../../models/linear-oauth-app.js"
import {
  type ConnectorAssetBytePool,
  connectorPathMatchesPreservation,
  createConnectorEntityAssetBytePool,
} from "../connectors/assets.js"
import {
  linearEntityMirrorFiles,
  linearIssueMirrorFiles,
  linearManagedPathsForEntity,
  linearMatchingExistingAssetPaths,
} from "./assets.js"
import { type LinearTokenRefreshHandler, withLinearClient } from "./client.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import { renderLinearUpdateSections } from "./content.js"
import type { LinearMirrorFile } from "./converter.js"
import {
  linearActorName,
  loadCycle,
  loadDocument,
  loadInitiative,
  loadInitiativeDocumentIds,
  loadInitiativeProjectIds,
  loadIssue,
  loadIssueLabel,
  loadProject,
  loadTeam,
  loadUser,
} from "./read.js"

export type LinearIncrementalChanges = {
  files: LinearMirrorFile[]
  deletePaths: string[]
  failures: Array<{ type: string; id: string; message: string }>
}

export type LinearEntityChange = {
  entityType:
    | "cycle"
    | "customerNeed"
    | "document"
    | "initiative"
    | "issue"
    | "issueLabel"
    | "project"
    | "team"
    | "user"
  externalId: string
  action: "upsert" | "delete"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function existingPathForId(paths: string[], id: string): string | undefined {
  return paths.find(
    (path) => path.startsWith("linear/") && path.endsWith(`--${id}.md`),
  )
}

export async function buildLinearIncrementalChanges(input: {
  env: Env
  connection: LinearConnection
  config: ParsedLinearRepoConfig
  entities: LinearEntityChange[]
  existingPaths: string[]
  bytePool?: ConnectorAssetBytePool
  existingShaByPath?: ReadonlyMap<string, string>
  onTokenRefresh?: LinearTokenRefreshHandler
}): Promise<LinearIncrementalChanges> {
  return withLinearClient(input, async (client) => {
    const files = new Map<string, LinearMirrorFile>()
    const deletePaths = new Set<string>()
    const failures: LinearIncrementalChanges["failures"] = []
    const preservePathPrefixes = new Set<string>()
    const onPreservePathPrefix = (prefix: string) => {
      preservePathPrefixes.add(prefix)
      for (const path of linearMatchingExistingAssetPaths(
        input.existingPaths,
        prefix,
      )) {
        preservePathPrefixes.add(path)
      }
    }
    const assetOptions = {
      bytePool: input.bytePool ?? createConnectorEntityAssetBytePool(),
      existingShaByPath:
        input.existingShaByPath ??
        new Map(input.existingPaths.map((path) => [path, ""])),
      onPreservePathPrefix,
    }
    const accessToken = linearAccessToken(input.connection)
    const includeNeeds = input.config.customerRequests === "limited"
    const selectedTeams = new Set(
      input.config.scopes
        .filter((scope) => scope.type === "team")
        .map((scope) => scope.externalId),
    )
    const selectedProjects = new Set(
      input.config.scopes
        .filter((scope) => scope.type === "project")
        .map((scope) => scope.externalId),
    )
    const selectedDocuments = new Set(
      input.config.scopes
        .filter((scope) => scope.type === "document")
        .map((scope) => scope.externalId),
    )
    const selectedInitiatives = new Set(
      input.config.scopes
        .filter((scope) => scope.type === "initiative")
        .map((scope) => scope.externalId),
    )
    let selectedInitiativeDescendants:
      | Promise<{ projectIds: Set<string>; documentIds: Set<string> }>
      | undefined

    function getSelectedInitiativeDescendants() {
      selectedInitiativeDescendants ??= Promise.all(
        [...selectedInitiatives].map(async (initiativeId) => ({
          projectIds: await loadInitiativeProjectIds(
            client,
            accessToken,
            initiativeId,
          ),
          documentIds: await loadInitiativeDocumentIds(
            client,
            accessToken,
            initiativeId,
          ),
        })),
      ).then((descendants) => ({
        projectIds: new Set(
          descendants.flatMap((descendant) => descendant.projectIds),
        ),
        documentIds: new Set(
          descendants.flatMap((descendant) => descendant.documentIds),
        ),
      }))
      return selectedInitiativeDescendants
    }

    async function projectIsSelectedOrInitiative(
      projectId: string | null | undefined,
    ) {
      if (!projectId) return false
      if (selectedProjects.has(projectId)) return true
      return (
        selectedInitiatives.size > 0 &&
        (await getSelectedInitiativeDescendants()).projectIds.has(projectId)
      )
    }

    async function projectIsInScope(
      projectId: string | null | undefined,
      teamIds: string[],
    ) {
      if (!projectId) return false
      if (await projectIsSelectedOrInitiative(projectId)) return true
      if (selectedTeams.size === 0) return false
      return teamIds.some((teamId) => selectedTeams.has(teamId))
    }

    function removeExisting(id: string) {
      for (const path of linearManagedPathsForEntity(input.existingPaths, id)) {
        deletePaths.add(path)
      }
    }

    function pruneStaleManagedPaths(id: string) {
      for (const path of linearManagedPathsForEntity(input.existingPaths, id)) {
        if (
          !files.has(path) &&
          ![...preservePathPrefixes].some((prefix) =>
            connectorPathMatchesPreservation(path, prefix),
          )
        ) {
          deletePaths.add(path)
        }
      }
    }

    function shouldUpdateExisting(id: string): boolean {
      return Boolean(existingPathForId(input.existingPaths, id))
    }

    for (const entity of input.entities) {
      if (entity.action === "delete") {
        removeExisting(entity.externalId)
        continue
      }

      try {
        let mirrored: LinearMirrorFile[] | undefined
        switch (entity.entityType) {
          case "team": {
            const team = await loadTeam(client, accessToken, entity.externalId)
            if (!selectedTeams.has(team.id)) {
              removeExisting(entity.externalId)
              break
            }
            mirrored = await linearEntityMirrorFiles({
              directory: "teams",
              type: "team",
              id: team.id,
              title: team.name,
              url: input.connection.workspaceUrlKey
                ? `https://linear.app/${input.connection.workspaceUrlKey}/team/${team.key}`
                : null,
              body: team.description,
              metadata: {
                key: team.key,
                parentId: team.parentId,
                createdAt: team.createdAt.toISOString(),
                updatedAt: team.updatedAt.toISOString(),
              },
              accessToken,
              ...assetOptions,
            })
            break
          }
          case "issue": {
            const loaded = await loadIssue(
              client,
              accessToken,
              entity.externalId,
              includeNeeds,
            )
            if (
              !selectedTeams.has(loaded.issue.teamId ?? "") &&
              !(await projectIsInScope(
                loaded.issue.projectId,
                loaded.projectTeamIds,
              ))
            ) {
              removeExisting(entity.externalId)
              break
            }
            if (includeNeeds) {
              for (const need of loaded.needs) {
                const needFiles = await linearEntityMirrorFiles({
                  directory: "customer-requests",
                  type: "customer_request",
                  id: need.id,
                  title: `Customer request ${need.id}`,
                  url: need.url,
                  body: need.content || need.body,
                  metadata: {
                    customerId: need.customerId,
                    projectId: need.projectId,
                    issueId: need.issueId,
                    priority: need.priority,
                    createdAt: need.createdAt.toISOString(),
                    updatedAt: need.updatedAt.toISOString(),
                  },
                  accessToken,
                  ...assetOptions,
                })
                for (const needFile of needFiles)
                  files.set(needFile.path, needFile)
                pruneStaleManagedPaths(need.id)
              }
            }
            mirrored = await linearIssueMirrorFiles(
              loaded.issue,
              accessToken,
              assetOptions,
            )
            break
          }
          case "project": {
            const project = await loadProject(
              client,
              accessToken,
              entity.externalId,
              {
                includeNeeds,
                includeDocuments: false,
              },
            )
            if (
              !(await projectIsSelectedOrInitiative(project.id)) &&
              !project.teamIds.some((teamId) => selectedTeams.has(teamId))
            ) {
              removeExisting(entity.externalId)
              break
            }
            if (includeNeeds) {
              for (const need of project.needs) {
                const needFiles = await linearEntityMirrorFiles({
                  directory: "customer-requests",
                  type: "customer_request",
                  id: need.id,
                  title: `Customer request ${need.id}`,
                  url: need.url,
                  body: need.content || need.body,
                  metadata: {
                    customerId: need.customerId,
                    projectId: need.projectId,
                    issueId: need.issueId,
                    priority: need.priority,
                    createdAt: need.createdAt.toISOString(),
                    updatedAt: need.updatedAt.toISOString(),
                  },
                  accessToken,
                  ...assetOptions,
                })
                for (const needFile of needFiles)
                  files.set(needFile.path, needFile)
                pruneStaleManagedPaths(need.id)
              }
            }
            mirrored = await linearEntityMirrorFiles({
              directory: "projects",
              type: "project",
              id: project.id,
              title: project.name,
              url: project.url,
              body: project.content || project.description,
              metadata: {
                statusId: project.statusId,
                leadId: project.leadId,
                priority: project.priorityLabel,
                progress: project.progress,
                startDate: project.startDate,
                targetDate: project.targetDate,
                updatedAt: project.updatedAt.toISOString(),
              },
              sections: renderLinearUpdateSections(project.updates),
              accessToken,
              ...assetOptions,
            })
            break
          }
          case "document": {
            const document = await loadDocument(
              client,
              accessToken,
              entity.externalId,
            )
            if (
              !selectedDocuments.has(document.id) &&
              !(await projectIsInScope(
                document.projectId,
                document.projectTeamIds,
              )) &&
              !(
                selectedInitiatives.size > 0 &&
                (await getSelectedInitiativeDescendants()).documentIds.has(
                  document.id,
                )
              )
            ) {
              removeExisting(entity.externalId)
              break
            }
            mirrored = await linearEntityMirrorFiles({
              directory: "documents",
              type: "document",
              id: document.id,
              title: document.title,
              url: document.url,
              body: document.content,
              metadata: {
                projectId: document.projectId,
                creatorId: document.creator?.id ?? null,
                updatedAt: document.updatedAt.toISOString(),
              },
              accessToken,
              ...assetOptions,
            })
            break
          }
          case "initiative": {
            const initiative = await loadInitiative(
              client,
              accessToken,
              entity.externalId,
            )
            if (!selectedInitiatives.has(initiative.id)) {
              removeExisting(entity.externalId)
              break
            }
            mirrored = await linearEntityMirrorFiles({
              directory: "initiatives",
              type: "initiative",
              id: initiative.id,
              title: initiative.name,
              url: initiative.url,
              body: initiative.content || initiative.description,
              metadata: {
                status: initiative.status,
                health: initiative.health,
                ownerId: initiative.ownerId,
                targetDate: initiative.targetDate,
                updatedAt: initiative.updatedAt.toISOString(),
              },
              sections: renderLinearUpdateSections(initiative.updates),
              accessToken,
              ...assetOptions,
            })
            break
          }
          case "cycle": {
            const cycle = await loadCycle(
              client,
              accessToken,
              entity.externalId,
            )
            if (!selectedTeams.has(cycle.teamId)) {
              removeExisting(entity.externalId)
              break
            }
            mirrored = await linearEntityMirrorFiles({
              directory: "cycles",
              type: "cycle",
              id: cycle.id,
              title: cycle.name || `Cycle ${cycle.number}`,
              metadata: {
                teamId: cycle.teamId,
                number: cycle.number,
                startsAt: cycle.startsAt.toISOString(),
                endsAt: cycle.endsAt.toISOString(),
                completedAt: cycle.completedAt?.toISOString() ?? null,
              },
              accessToken,
              ...assetOptions,
            })
            break
          }
          case "issueLabel": {
            const label = await loadIssueLabel(
              client,
              accessToken,
              entity.externalId,
            )
            if (!selectedTeams.has(label.teamId ?? "")) {
              removeExisting(entity.externalId)
              break
            }
            mirrored = await linearEntityMirrorFiles({
              directory: "labels",
              type: "issue_label",
              id: label.id,
              title: label.name,
              body: label.description,
              metadata: { teamId: label.teamId, color: label.color },
              accessToken,
              ...assetOptions,
            })
            break
          }
          case "user": {
            if (!shouldUpdateExisting(entity.externalId)) break
            const user = await loadUser(client, accessToken, entity.externalId)
            mirrored = await linearEntityMirrorFiles({
              directory: "users",
              type: "user",
              id: user.id,
              title: linearActorName(user) || user.id,
              metadata: {
                active: user.active,
                admin: user.admin,
                guest: user.guest,
                avatarUrl: user.avatarUrl,
              },
              accessToken,
              ...assetOptions,
            })
            break
          }
          default:
            break
        }
        if (mirrored) {
          for (const file of mirrored) files.set(file.path, file)
          pruneStaleManagedPaths(entity.externalId)
        }
      } catch (error) {
        failures.push({
          type: entity.entityType,
          id: entity.externalId,
          message: errorMessage(error),
        })
      }
    }

    return {
      files: [...files.values()],
      deletePaths: [...deletePaths],
      failures,
    }
  })
}
