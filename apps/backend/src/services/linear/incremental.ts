import type { CustomerNeed, Issue } from "@linear/sdk"
import type { Env } from "../../config/env.js"
import type {
  LinearConnection,
  LinearDirtyEntity,
} from "../../models/linear-connector.js"
import { collectLinearConnectionPages, withLinearClient } from "./client.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import {
  type LinearMirrorFile,
  renderLinearEntity,
  renderLinearIssue,
} from "./converter.js"

export type LinearIncrementalChanges = {
  files: LinearMirrorFile[]
  deletePaths: string[]
  failures: Array<{ type: string; id: string; message: string }>
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
  dirty: LinearDirtyEntity[]
  existingPaths: string[]
  onTokenRefresh?: (tokens: {
    accessToken: string
    refreshToken: string | null
    accessTokenExpiresAt: string
  }) => Promise<void>
}): Promise<LinearIncrementalChanges> {
  return withLinearClient(input, async (client) => {
    const files = new Map<string, LinearMirrorFile>()
    const deletePaths = new Set<string>()
    const failures: LinearIncrementalChanges["failures"] = []
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

    function shouldUpdateExisting(id: string): boolean {
      return Boolean(existingPathForId(input.existingPaths, id))
    }

    function renderCustomerNeed(need: CustomerNeed): LinearMirrorFile {
      return renderLinearEntity({
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
      })
    }

    async function renderIssue(issue: Issue): Promise<LinearMirrorFile> {
      const [comments, attachments, state] = await Promise.all([
        collectLinearConnectionPages(() => issue.comments({ first: 100 })),
        collectLinearConnectionPages(() => issue.attachments({ first: 100 })),
        issue.state,
      ])
      return renderLinearIssue({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        priorityLabel: issue.priorityLabel,
        state: state?.name ?? null,
        teamId: issue.teamId ?? null,
        projectId: issue.projectId ?? null,
        cycleId: issue.cycleId ?? null,
        assigneeId: issue.assigneeId ?? null,
        creatorId: issue.creatorId ?? null,
        labelIds: issue.labelIds,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        comments: comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          userId: comment.userId ?? null,
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
      })
    }

    for (const dirty of input.dirty) {
      const existingPath = existingPathForId(
        input.existingPaths,
        dirty.externalId,
      )
      if (dirty.action === "delete") {
        if (existingPath) deletePaths.add(existingPath)
        continue
      }

      try {
        let file: LinearMirrorFile | undefined
        switch (dirty.entityType) {
          case "issue": {
            const issue = await client.issue(dirty.externalId)
            if (
              !shouldUpdateExisting(issue.id) &&
              !selectedTeams.has(issue.teamId ?? "") &&
              !selectedProjects.has(issue.projectId ?? "")
            ) {
              break
            }
            if (input.config.customerRequests === "limited") {
              const needs = await collectLinearConnectionPages(() =>
                issue.needs({ first: 100 }),
              )
              for (const need of needs) {
                const needFile = renderCustomerNeed(need)
                files.set(needFile.path, needFile)
              }
            }
            file = await renderIssue(issue)
            break
          }
          case "project": {
            const project = await client.project(dirty.externalId)
            const teams = await collectLinearConnectionPages(() =>
              project.teams({ first: 100 }),
            )
            if (
              !shouldUpdateExisting(project.id) &&
              !selectedProjects.has(project.id) &&
              !teams.some((team) => selectedTeams.has(team.id))
            ) {
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
                const needFile = renderCustomerNeed(need)
                files.set(needFile.path, needFile)
              }
            }
            file = renderLinearEntity({
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
              sections: updates.map((update) => ({
                heading: `Update · ${update.createdAt.toISOString()}`,
                body: update.body?.trim() || "_No update body._",
              })),
            })
            break
          }
          case "document": {
            const document = await client.document(dirty.externalId)
            if (
              !shouldUpdateExisting(document.id) &&
              !selectedDocuments.has(document.id) &&
              !selectedProjects.has(document.projectId ?? "")
            ) {
              break
            }
            file = renderLinearEntity({
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
            })
            break
          }
          case "initiative": {
            const initiative = await client.initiative(dirty.externalId)
            if (
              !shouldUpdateExisting(initiative.id) &&
              !selectedInitiatives.has(initiative.id)
            ) {
              break
            }
            const updates = await collectLinearConnectionPages(() =>
              initiative.initiativeUpdates({ first: 100 }),
            )
            file = renderLinearEntity({
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
              sections: updates.map((update) => ({
                heading: `Update · ${update.createdAt.toISOString()}`,
                body: update.body?.trim() || "_No update body._",
              })),
            })
            break
          }
          case "cycle": {
            const cycle = await client.cycle(dirty.externalId)
            if (
              !shouldUpdateExisting(cycle.id) &&
              !selectedTeams.has(cycle.teamId ?? "")
            ) {
              break
            }
            file = renderLinearEntity({
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
            })
            break
          }
          case "issueLabel": {
            const label = await client.issueLabel(dirty.externalId)
            if (
              !shouldUpdateExisting(label.id) &&
              !selectedTeams.has(label.teamId ?? "")
            ) {
              break
            }
            file = renderLinearEntity({
              directory: "labels",
              type: "issue_label",
              id: label.id,
              title: label.name,
              body: label.description,
              metadata: { teamId: label.teamId ?? null, color: label.color },
            })
            break
          }
          case "user": {
            if (!shouldUpdateExisting(dirty.externalId)) break
            const user = await client.user(dirty.externalId)
            file = renderLinearEntity({
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
            break
          }
          default:
            break
        }
        if (file) files.set(file.path, file)
      } catch (error) {
        failures.push({
          type: dirty.entityType,
          id: dirty.externalId,
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
