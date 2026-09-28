import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import { linearAccessToken } from "../../models/linear-oauth-app.js"
import { createConnectorAssetBytePool } from "../connectors/assets.js"
import {
  linearEntityMirrorFiles,
  linearIssueMirrorFiles,
  linearMatchingExistingAssetPaths,
} from "./assets.js"
import { type LinearTokenRefreshHandler, withLinearClient } from "./client.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import type { LinearMirrorFile } from "./converter.js"
import type { LinearActorFragment } from "./documents.generated.js"
import {
  type LoadedDocument,
  type LoadedInitiative,
  type LoadedIssue,
  type LoadedNeed,
  type LoadedProject,
  linearActorName,
  loadDocument,
  loadInitiative,
  loadInitiativeDocumentIds,
  loadInitiativeProjectIds,
  loadProject,
  loadProjectIssues,
  loadTeam,
  loadTeamCycles,
  loadTeamIssues,
  loadTeamLabels,
  loadTeamProjects,
} from "./read.js"

export type LinearMirrorBuildResult = {
  files: LinearMirrorFile[]
  failures: Array<{ type: string; id: string; message: string }>
  preservePathPrefixes: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function renderLinearUpdateSections(
  updates: Array<{
    body?: string | null
    health?: string | null
    createdAt: Date
  }>,
) {
  return updates.map((update) => ({
    heading: `Update · ${update.createdAt.toISOString()}`,
    body: [
      update.health ? `Health: ${update.health}` : "",
      update.body?.trim() || "_No update body._",
    ]
      .filter(Boolean)
      .join("\n\n"),
  }))
}

const scopeOrder = {
  team: 0,
  project: 1,
  initiative: 2,
  document: 3,
} as const

export async function buildLinearMirror(input: {
  env: Env
  connection: LinearConnection
  config: ParsedLinearRepoConfig
  onTokenRefresh?: LinearTokenRefreshHandler
  existingBlobs?: ReadonlyArray<{ path: string; sha: string }>
}): Promise<LinearMirrorBuildResult> {
  return withLinearClient(input, async (client) => {
    const files = new Map<string, LinearMirrorFile>()
    const failures: LinearMirrorBuildResult["failures"] = []
    const preservePathPrefixes = new Set<string>()
    const assetBytePool = createConnectorAssetBytePool()
    const existingShaByPath = new Map(
      (input.existingBlobs ?? []).map((blob) => [blob.path, blob.sha]),
    )
    const onPreservePathPrefix = (prefix: string) => {
      preservePathPrefixes.add(prefix)
      for (const path of linearMatchingExistingAssetPaths(
        existingShaByPath.keys(),
        prefix,
      )) {
        preservePathPrefixes.add(path)
      }
    }
    const seen = {
      teams: new Set<string>(),
      projects: new Set<string>(),
      issues: new Set<string>(),
      documents: new Set<string>(),
      initiatives: new Set<string>(),
      cycles: new Set<string>(),
      labels: new Set<string>(),
      users: new Set<string>(),
      needs: new Set<string>(),
    }
    const referencedUsers = new Map<string, LinearActorFragment>()
    const includeNeeds = input.config.customerRequests === "limited"
    const accessToken = linearAccessToken(input.connection)

    function addFile(file: LinearMirrorFile) {
      files.set(file.path, file)
    }

    function addFiles(next: LinearMirrorFile[]) {
      for (const file of next) addFile(file)
    }

    function rememberActors(actors: Array<LinearActorFragment | null>) {
      for (const actor of actors) {
        if (actor) referencedUsers.set(actor.id, actor)
      }
    }

    async function addEntity(
      renderInput: Omit<
        Parameters<typeof linearEntityMirrorFiles>[0],
        "accessToken"
      >,
    ) {
      addFiles(
        await linearEntityMirrorFiles({
          ...renderInput,
          accessToken,
          onPreservePathPrefix,
          bytePool: assetBytePool,
          existingShaByPath,
        }),
      )
    }

    async function addNeed(need: LoadedNeed, fallbackIssueId: string | null) {
      if (seen.needs.has(need.id)) return
      seen.needs.add(need.id)
      await addEntity({
        directory: "customer-requests",
        type: "customer_request",
        id: need.id,
        title: `Customer request ${need.id}`,
        url: need.url,
        body: need.content || need.body,
        metadata: {
          customerId: need.customerId,
          projectId: need.projectId,
          issueId: need.issueId ?? fallbackIssueId,
          priority: need.priority,
          createdAt: need.createdAt.toISOString(),
          updatedAt: need.updatedAt.toISOString(),
        },
      })
      rememberActors([need.creator])
    }

    async function addLoadedDocument(document: LoadedDocument) {
      if (seen.documents.has(document.id)) return
      seen.documents.add(document.id)
      await addEntity({
        directory: "documents",
        type: "document",
        id: document.id,
        title: document.title,
        url: document.url,
        body: document.content,
        metadata: {
          projectId: document.projectId,
          creatorId: document.creator?.id ?? null,
          createdAt: document.createdAt.toISOString(),
          updatedAt: document.updatedAt.toISOString(),
        },
      })
      rememberActors([document.creator])
    }

    async function addLoadedIssue(loaded: LoadedIssue) {
      if (seen.issues.has(loaded.issue.id)) return
      seen.issues.add(loaded.issue.id)
      rememberActors(loaded.actors)
      addFiles(
        await linearIssueMirrorFiles(loaded.issue, accessToken, {
          onPreservePathPrefix,
          bytePool: assetBytePool,
          existingShaByPath,
        }),
      )
      for (const need of loaded.needs) {
        await addNeed(need, loaded.issue.id)
      }
    }

    async function addLoadedProject(
      project: LoadedProject,
      includeIssues: boolean,
    ) {
      await addEntity({
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
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
        },
        sections: renderLinearUpdateSections(project.updates),
      })
      rememberActors(project.actors)
      for (const document of project.documents) {
        await addLoadedDocument(document)
      }
      for (const need of project.needs) await addNeed(need, null)
      const coveredBySelectedTeam =
        project.teamIds.length > 0 &&
        project.teamIds.every((teamId) => seen.teams.has(teamId))
      if (!includeIssues || coveredBySelectedTeam) return
      for (const issue of await loadProjectIssues(
        client,
        project.id,
        includeNeeds,
      )) {
        try {
          await addLoadedIssue(issue)
        } catch (error) {
          failures.push({
            type: "issue",
            id: issue.issue.id,
            message: errorMessage(error),
          })
        }
      }
    }

    async function addProject(projectId: string, includeIssues: boolean) {
      if (seen.projects.has(projectId)) return
      seen.projects.add(projectId)
      try {
        const project = await loadProject(client, projectId, {
          includeNeeds,
          includeDocuments: true,
        })
        await addLoadedProject(project, includeIssues)
      } catch (error) {
        failures.push({
          type: "project",
          id: projectId,
          message: errorMessage(error),
        })
      }
    }

    async function addInitiativeRecord(initiative: LoadedInitiative) {
      await addEntity({
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
          parentInitiativeId: initiative.parentInitiativeId,
          targetDate: initiative.targetDate,
          createdAt: initiative.createdAt.toISOString(),
          updatedAt: initiative.updatedAt.toISOString(),
        },
        sections: renderLinearUpdateSections(initiative.updates),
      })
      rememberActors(initiative.actors)
    }

    async function addTeam(teamId: string) {
      if (seen.teams.has(teamId)) return
      seen.teams.add(teamId)
      try {
        const team = await loadTeam(client, teamId)
        const [issues, projects, cycles, labels] = await Promise.all([
          loadTeamIssues(client, teamId, includeNeeds),
          loadTeamProjects(client, teamId, includeNeeds),
          loadTeamCycles(client, teamId),
          loadTeamLabels(client, teamId),
        ])
        await addEntity({
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
        })
        for (const issue of issues) {
          try {
            await addLoadedIssue(issue)
          } catch (error) {
            failures.push({
              type: "issue",
              id: issue.issue.id,
              message: errorMessage(error),
            })
          }
        }
        for (const project of projects) {
          if (seen.projects.has(project.id)) continue
          seen.projects.add(project.id)
          try {
            await addLoadedProject(project, false)
          } catch (error) {
            failures.push({
              type: "project",
              id: project.id,
              message: errorMessage(error),
            })
          }
        }
        for (const cycle of cycles) {
          if (seen.cycles.has(cycle.id)) continue
          seen.cycles.add(cycle.id)
          await addEntity({
            directory: "cycles",
            type: "cycle",
            id: cycle.id,
            title: cycle.name || `Cycle ${cycle.number}`,
            metadata: {
              teamId,
              number: cycle.number,
              startsAt: cycle.startsAt.toISOString(),
              endsAt: cycle.endsAt.toISOString(),
              completedAt: cycle.completedAt?.toISOString() ?? null,
            },
          })
        }
        for (const label of labels) {
          if (seen.labels.has(label.id)) continue
          seen.labels.add(label.id)
          await addEntity({
            directory: "labels",
            type: "issue_label",
            id: label.id,
            title: label.name,
            body: label.description,
            metadata: { teamId, color: label.color },
          })
        }
      } catch (error) {
        failures.push({
          type: "team",
          id: teamId,
          message: errorMessage(error),
        })
      }
    }

    async function addInitiative(initiativeId: string) {
      if (seen.initiatives.has(initiativeId)) return
      seen.initiatives.add(initiativeId)
      try {
        const initiative = await loadInitiative(client, initiativeId)
        const [projectIds, documentIds] = await Promise.all([
          loadInitiativeProjectIds(client, initiativeId),
          loadInitiativeDocumentIds(client, initiativeId),
        ])
        await addInitiativeRecord(initiative)
        for (const projectId of projectIds) {
          await addProject(projectId, true)
        }
        for (const documentId of documentIds) {
          if (seen.documents.has(documentId)) continue
          await addLoadedDocument(await loadDocument(client, documentId))
        }
      } catch (error) {
        failures.push({
          type: "initiative",
          id: initiativeId,
          message: errorMessage(error),
        })
      }
    }

    async function addSelectedScope(
      scope: ParsedLinearRepoConfig["scopes"][number],
    ) {
      try {
        switch (scope.type) {
          case "team":
            await addTeam(scope.externalId)
            return
          case "project":
            await addProject(scope.externalId, true)
            return
          case "document":
            await addLoadedDocument(
              await loadDocument(client, scope.externalId),
            )
            return
          case "initiative":
            await addInitiative(scope.externalId)
            return
        }
      } catch (error) {
        failures.push({
          type: scope.type,
          id: scope.externalId,
          message: errorMessage(error),
        })
      }
    }

    const scopes = [...input.config.scopes].sort(
      (left, right) => scopeOrder[left.type] - scopeOrder[right.type],
    )
    for (const scope of scopes) await addSelectedScope(scope)

    for (const user of referencedUsers.values()) {
      if (seen.users.has(user.id)) continue
      seen.users.add(user.id)
      await addEntity({
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
      })
    }

    return {
      files: [...files.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      failures,
      preservePathPrefixes: [...preservePathPrefixes],
    }
  })
}
