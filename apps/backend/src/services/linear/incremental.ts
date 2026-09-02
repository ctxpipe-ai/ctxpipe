import type { CustomerNeed, Issue } from "@linear/sdk"
import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
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
import {
  collectLinearConnectionPages,
  type LinearTokenRefreshHandler,
  withLinearClient,
} from "./client.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import { renderLinearUpdateSections } from "./content.js"
import type { LinearMirrorFile } from "./converter.js"

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

async function settleRelation<T>(
  value: PromiseLike<T> | undefined,
): Promise<T | undefined> {
  if (!value) return undefined
  try {
    return await value
  } catch {
    return undefined
  }
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
    const projectScope = new Map<string, Promise<boolean>>()

    function getSelectedInitiativeDescendants() {
      selectedInitiativeDescendants ??= Promise.all(
        [...selectedInitiatives].map(async (initiativeId) => {
          const initiative = await client.initiative(initiativeId)
          const [projects, documents] = await Promise.all([
            collectLinearConnectionPages(() =>
              initiative.projects({ first: 100, includeArchived: true }),
            ),
            collectLinearConnectionPages(() =>
              initiative.documents({ first: 100, includeArchived: true }),
            ),
          ])
          return { projects, documents }
        }),
      ).then((descendants) => ({
        projectIds: new Set(
          descendants.flatMap(({ projects }) =>
            projects.map((project) => project.id),
          ),
        ),
        documentIds: new Set(
          descendants.flatMap(({ documents }) =>
            documents.map((document) => document.id),
          ),
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

    async function projectIsInScope(projectId: string | null | undefined) {
      if (!projectId) return false
      if (await projectIsSelectedOrInitiative(projectId)) return true
      if (selectedTeams.size === 0) return false
      let pending = projectScope.get(projectId)
      if (!pending) {
        pending = client.project(projectId).then(async (project) => {
          const teams = await collectLinearConnectionPages(() =>
            project.teams({ first: 100 }),
          )
          return teams.some((team) => selectedTeams.has(team.id))
        })
        projectScope.set(projectId, pending)
      }
      return pending
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

    async function renderCustomerNeed(
      need: CustomerNeed,
    ): Promise<LinearMirrorFile[]> {
      return linearEntityMirrorFiles({
        directory: "customer-requests",
        type: "customer_request",
        id: need.id,
        title: `Customer request ${need.id}`,
        url: need.url,
        body: need.content || need.body,
        metadata: {
          customerId: need.customerId ?? null,
          projectId: need.projectId ?? null,
          issueId: need.issueId ?? null,
          priority: need.priority,
          createdAt: need.createdAt.toISOString(),
          updatedAt: need.updatedAt.toISOString(),
        },
        accessToken: input.connection.accessToken,
        ...assetOptions,
      })
    }

    async function renderIssue(issue: Issue): Promise<LinearMirrorFile[]> {
      const [
        comments,
        attachments,
        state,
        team,
        project,
        cycle,
        assignee,
        creator,
        labels,
      ] = await Promise.all([
        collectLinearConnectionPages(() => issue.comments({ first: 100 })),
        collectLinearConnectionPages(() => issue.attachments({ first: 100 })),
        issue.state,
        settleRelation(issue.team),
        settleRelation(issue.project),
        settleRelation(issue.cycle),
        settleRelation(issue.assignee),
        settleRelation(issue.creator),
        collectLinearConnectionPages(() => issue.labels({ first: 100 })),
      ])
      const commentAuthors = await Promise.all(
        comments.map(async (comment) => {
          const user = await settleRelation(comment.user)
          return user ? user.displayName || user.name || null : null
        }),
      )
      return linearIssueMirrorFiles(
        {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          url: issue.url,
          priorityLabel: issue.priorityLabel,
          state: state?.name ?? null,
          teamId: issue.teamId ?? team?.id ?? null,
          teamKey: team?.key ?? null,
          teamName: team?.name ?? null,
          projectId: issue.projectId ?? project?.id ?? null,
          projectName: project?.name ?? null,
          cycleId: issue.cycleId ?? cycle?.id ?? null,
          cycleName: cycle?.name ?? null,
          assigneeId: issue.assigneeId ?? assignee?.id ?? null,
          assignee: assignee
            ? assignee.displayName || assignee.name || null
            : null,
          creatorId: issue.creatorId ?? creator?.id ?? null,
          creator: creator ? creator.displayName || creator.name || null : null,
          labels: labels.map((label) => ({
            id: label.id,
            name: label.name,
          })),
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          comments: comments.map((comment, index) => ({
            id: comment.id,
            body: comment.body,
            userId: comment.userId ?? null,
            userName: commentAuthors[index] ?? null,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
          })),
          attachments: attachments.map((attachment) => ({
            id: attachment.id,
            title: attachment.title,
            url: attachment.url,
            sourceType: attachment.sourceType ?? null,
            metadata:
              attachment.metadata &&
              typeof attachment.metadata === "object" &&
              !Array.isArray(attachment.metadata)
                ? (attachment.metadata as Record<string, unknown>)
                : null,
          })),
        },
        input.connection.accessToken,
        assetOptions,
      )
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
            const team = await client.team(entity.externalId)
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
                parentId: team.parentId ?? null,
                createdAt: team.createdAt.toISOString(),
                updatedAt: team.updatedAt.toISOString(),
              },
              accessToken: input.connection.accessToken,
              ...assetOptions,
            })
            break
          }
          case "issue": {
            const issue = await client.issue(entity.externalId)
            if (
              !selectedTeams.has(issue.teamId ?? "") &&
              !(await projectIsInScope(issue.projectId))
            ) {
              removeExisting(entity.externalId)
              break
            }
            if (input.config.customerRequests === "limited") {
              const needs = await collectLinearConnectionPages(() =>
                issue.needs({ first: 100 }),
              )
              for (const need of needs) {
                for (const needFile of await renderCustomerNeed(need)) {
                  files.set(needFile.path, needFile)
                }
                pruneStaleManagedPaths(need.id)
              }
            }
            mirrored = await renderIssue(issue)
            break
          }
          case "project": {
            const project = await client.project(entity.externalId)
            const teams = await collectLinearConnectionPages(() =>
              project.teams({ first: 100 }),
            )
            if (
              !(await projectIsSelectedOrInitiative(project.id)) &&
              !teams.some((team) => selectedTeams.has(team.id))
            ) {
              removeExisting(entity.externalId)
              break
            }
            const updates = await collectLinearConnectionPages(() =>
              project.projectUpdates({ first: 100 }),
            )
            if (input.config.customerRequests === "limited") {
              const needs = await collectLinearConnectionPages(() =>
                project.needs({ first: 100 }),
              )
              for (const need of needs) {
                for (const needFile of await renderCustomerNeed(need)) {
                  files.set(needFile.path, needFile)
                }
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
                statusId: project.statusId ?? null,
                leadId: project.leadId ?? null,
                priority: project.priorityLabel,
                progress: project.progress,
                startDate: project.startDate ?? null,
                targetDate: project.targetDate ?? null,
                updatedAt: project.updatedAt.toISOString(),
              },
              sections: renderLinearUpdateSections(updates),
              accessToken: input.connection.accessToken,
              ...assetOptions,
            })
            break
          }
          case "document": {
            const document = await client.document(entity.externalId)
            if (
              !selectedDocuments.has(document.id) &&
              !(await projectIsInScope(document.projectId)) &&
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
                projectId: document.projectId ?? null,
                creatorId: document.creatorId ?? null,
                updatedAt: document.updatedAt.toISOString(),
              },
              accessToken: input.connection.accessToken,
              ...assetOptions,
            })
            break
          }
          case "initiative": {
            const initiative = await client.initiative(entity.externalId)
            if (!selectedInitiatives.has(initiative.id)) {
              removeExisting(entity.externalId)
              break
            }
            const updates = await collectLinearConnectionPages(() =>
              initiative.initiativeUpdates({ first: 100 }),
            )
            mirrored = await linearEntityMirrorFiles({
              directory: "initiatives",
              type: "initiative",
              id: initiative.id,
              title: initiative.name,
              url: initiative.url,
              body: initiative.content || initiative.description,
              metadata: {
                status: initiative.status,
                health: initiative.health ?? null,
                ownerId: initiative.ownerId ?? null,
                targetDate: initiative.targetDate ?? null,
                updatedAt: initiative.updatedAt.toISOString(),
              },
              sections: renderLinearUpdateSections(updates),
              accessToken: input.connection.accessToken,
              ...assetOptions,
            })
            break
          }
          case "cycle": {
            const cycle = await client.cycle(entity.externalId)
            if (!selectedTeams.has(cycle.teamId ?? "")) {
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
              accessToken: input.connection.accessToken,
              ...assetOptions,
            })
            break
          }
          case "issueLabel": {
            const label = await client.issueLabel(entity.externalId)
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
              metadata: { teamId: label.teamId ?? null, color: label.color },
              accessToken: input.connection.accessToken,
              ...assetOptions,
            })
            break
          }
          case "user": {
            if (!shouldUpdateExisting(entity.externalId)) break
            const user = await client.user(entity.externalId)
            mirrored = await linearEntityMirrorFiles({
              directory: "users",
              type: "user",
              id: user.id,
              title: user.displayName || user.name,
              metadata: {
                active: user.active,
                admin: user.admin,
                guest: user.guest,
                avatarUrl: user.avatarUrl ?? null,
              },
              accessToken: input.connection.accessToken,
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
