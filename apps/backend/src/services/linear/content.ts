import type { Document, Initiative, Issue, Project, User } from "@linear/sdk"
import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import { createConnectorAssetBytePool } from "../connectors/assets.js"
import {
  linearEntityMirrorFiles,
  linearIssueMirrorFiles,
  linearMatchingExistingAssetPaths,
} from "./assets.js"
import {
  collectLinearConnectionPages,
  type LinearTokenRefreshHandler,
  withLinearClient,
} from "./client.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import type { LinearMirrorFile } from "./converter.js"

export type LinearMirrorBuildResult = {
  files: LinearMirrorFile[]
  failures: Array<{ type: string; id: string; message: string }>
  preservePathPrefixes: string[]
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
    const referencedUsers = new Map<string, User>()

    function addFile(file: LinearMirrorFile) {
      files.set(file.path, file)
    }

    function addFiles(next: LinearMirrorFile[]) {
      for (const file of next) addFile(file)
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
          accessToken: input.connection.accessToken,
          onPreservePathPrefix,
          bytePool: assetBytePool,
          existingShaByPath,
        }),
      )
    }

    async function captureUser(userPromise: PromiseLike<User> | undefined) {
      if (!userPromise) return
      try {
        const user = await userPromise
        referencedUsers.set(user.id, user)
      } catch {
        // A deleted/inaccessible user should not fail otherwise valid content.
      }
    }

    async function addDocument(document: Document) {
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
          projectId: document.projectId ?? null,
          creatorId: document.creatorId ?? null,
          createdAt: document.createdAt.toISOString(),
          updatedAt: document.updatedAt.toISOString(),
        },
      })
      await captureUser(document.creator)
    }

    async function addIssue(issue: Issue) {
      if (seen.issues.has(issue.id)) return
      seen.issues.add(issue.id)
      try {
        const [
          comments,
          attachments,
          state,
          needs,
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
          input.config.customerRequests === "limited"
            ? collectLinearConnectionPages(() => issue.needs({ first: 100 }))
            : Promise.resolve([]),
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
            if (user) referencedUsers.set(user.id, user)
            return user ? user.displayName || user.name || null : null
          }),
        )
        if (assignee) referencedUsers.set(assignee.id, assignee)
        if (creator) referencedUsers.set(creator.id, creator)
        addFiles(
          await linearIssueMirrorFiles(
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
              creator: creator
                ? creator.displayName || creator.name || null
                : null,
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
            {
              onPreservePathPrefix,
              bytePool: assetBytePool,
              existingShaByPath,
            },
          ),
        )
        for (const need of needs) {
          if (seen.needs.has(need.id)) continue
          seen.needs.add(need.id)
          await addEntity({
            directory: "customer-requests",
            type: "customer_request",
            id: need.id,
            title: `Customer request ${need.id}`,
            url: need.url,
            body: need.content || need.body,
            metadata: {
              customerId: need.customerId ?? null,
              projectId: need.projectId ?? null,
              issueId: need.issueId ?? issue.id,
              priority: need.priority,
              createdAt: need.createdAt.toISOString(),
              updatedAt: need.updatedAt.toISOString(),
            },
          })
          await captureUser(need.creator)
        }
      } catch (error) {
        failures.push({
          type: "issue",
          id: issue.id,
          message: errorMessage(error),
        })
      }
    }

    async function addProject(project: Project) {
      if (seen.projects.has(project.id)) return
      seen.projects.add(project.id)
      try {
        const [issues, updates, needs, documents] = await Promise.all([
          collectLinearConnectionPages(() =>
            project.issues({ first: 100, includeArchived: true }),
          ),
          collectLinearConnectionPages(() =>
            project.projectUpdates({ first: 100 }),
          ),
          input.config.customerRequests === "limited"
            ? collectLinearConnectionPages(() => project.needs({ first: 100 }))
            : Promise.resolve([]),
          collectLinearConnectionPages(() =>
            project.documents({ first: 100, includeArchived: true }),
          ),
        ])
        await addEntity({
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
            createdAt: project.createdAt.toISOString(),
            updatedAt: project.updatedAt.toISOString(),
          },
          sections: renderLinearUpdateSections(updates),
        })
        await captureUser(project.lead)
        for (const issue of issues) await addIssue(issue)
        for (const document of documents) await addDocument(document)
        for (const need of needs) {
          if (seen.needs.has(need.id)) continue
          seen.needs.add(need.id)
          await addEntity({
            directory: "customer-requests",
            type: "customer_request",
            id: need.id,
            title: `Customer request ${need.id}`,
            url: need.url,
            body: need.content || need.body,
            metadata: {
              customerId: need.customerId ?? null,
              projectId: need.projectId ?? project.id,
              issueId: need.issueId ?? null,
              priority: need.priority,
              createdAt: need.createdAt.toISOString(),
              updatedAt: need.updatedAt.toISOString(),
            },
          })
          await captureUser(need.creator)
        }
      } catch (error) {
        failures.push({
          type: "project",
          id: project.id,
          message: errorMessage(error),
        })
      }
    }

    async function addInitiative(initiative: Initiative) {
      if (seen.initiatives.has(initiative.id)) return
      seen.initiatives.add(initiative.id)
      try {
        const [updates, projects, documents] = await Promise.all([
          collectLinearConnectionPages(() =>
            initiative.initiativeUpdates({ first: 100 }),
          ),
          collectLinearConnectionPages(() =>
            initiative.projects({ first: 100, includeArchived: true }),
          ),
          collectLinearConnectionPages(() =>
            initiative.documents({ first: 100, includeArchived: true }),
          ),
        ])
        await addEntity({
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
            parentInitiativeId: initiative.parentInitiativeId ?? null,
            targetDate: initiative.targetDate ?? null,
            createdAt: initiative.createdAt.toISOString(),
            updatedAt: initiative.updatedAt.toISOString(),
          },
          sections: renderLinearUpdateSections(updates),
        })
        await captureUser(initiative.owner)
        for (const project of projects) await addProject(project)
        for (const document of documents) await addDocument(document)
      } catch (error) {
        failures.push({
          type: "initiative",
          id: initiative.id,
          message: errorMessage(error),
        })
      }
    }

    async function addTeam(teamId: string) {
      if (seen.teams.has(teamId)) return
      seen.teams.add(teamId)
      try {
        const team = await client.team(teamId)
        const [issues, projects, cycles, labels] = await Promise.all([
          collectLinearConnectionPages(() =>
            team.issues({ first: 100, includeArchived: true }),
          ),
          collectLinearConnectionPages(() =>
            team.projects({ first: 100, includeArchived: true }),
          ),
          collectLinearConnectionPages(() =>
            team.cycles({ first: 100, includeArchived: true }),
          ),
          collectLinearConnectionPages(() =>
            team.labels({ first: 100, includeArchived: true }),
          ),
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
            parentId: team.parentId ?? null,
            createdAt: team.createdAt.toISOString(),
            updatedAt: team.updatedAt.toISOString(),
          },
        })
        for (const issue of issues) await addIssue(issue)
        for (const project of projects) await addProject(project)
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

    async function addSelectedScope(
      scope: ParsedLinearRepoConfig["scopes"][number],
    ) {
      try {
        switch (scope.type) {
          case "team":
            await addTeam(scope.externalId)
            return
          case "project":
            await addProject(await client.project(scope.externalId))
            return
          case "document":
            await addDocument(await client.document(scope.externalId))
            return
          case "initiative":
            await addInitiative(await client.initiative(scope.externalId))
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

    for (const scope of input.config.scopes) await addSelectedScope(scope)

    for (const user of referencedUsers.values()) {
      if (seen.users.has(user.id)) continue
      seen.users.add(user.id)
      await addEntity({
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
