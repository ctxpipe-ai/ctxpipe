import type { Env } from "../../config/env.js"
import type { LinearConnection } from "../../models/linear-connector.js"
import { type LinearTokenRefreshHandler, withLinearClient } from "./client.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import { renderLinearEntity, renderLinearIssue } from "./converter.js"
import type { LinearActorFragment } from "./documents.generated.js"
import {
  type LoadedCycle,
  type LoadedDocument,
  type LoadedIssue,
  type LoadedLabel,
  type LoadedNeed,
  type LoadedProject,
  linearActorName,
  loadDocument,
  loadInitiative,
  loadProject,
  loadTeam,
  readInitiativeDocumentPage,
  readInitiativeProjectPage,
  readProjectIssuePage,
  readTeamCyclePage,
  readTeamIssuePage,
  readTeamLabelPage,
  readTeamProjectPage,
} from "./read.js"

export type LinearMirrorPageRequest =
  | { kind: "team-record"; teamId: string }
  | { kind: "team-issues"; teamId: string; after: string | null }
  | { kind: "team-projects"; teamId: string; after: string | null }
  | { kind: "team-cycles"; teamId: string; after: string | null }
  | { kind: "team-labels"; teamId: string; after: string | null }
  | { kind: "project-record"; projectId: string }
  | { kind: "project-issues"; projectId: string; after: string | null }
  | { kind: "initiative-record"; initiativeId: string }
  | { kind: "initiative-projects"; initiativeId: string; after: string | null }
  | { kind: "initiative-documents"; initiativeId: string; after: string | null }
  | { kind: "document"; documentId: string }

export type LinearMirrorPage = {
  files: Array<{ path: string; content: string }>
  nextAfter: string | null
  failures: Array<{ type: string; id: string; message: string }>
  projects: Array<{ id: string; teamIds: string[] }>
  documentIds: string[]
  childIds: string[]
}

export type LinearMirrorBuildResult = {
  files: Array<{ path: string; content: string }>
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

function createTextPage(workspaceUrlKey: string | null) {
  const files = new Map<string, { path: string; content: string }>()
  const failures: LinearMirrorPage["failures"] = []
  const projects: LinearMirrorPage["projects"] = []
  const documentIds = new Set<string>()
  const seenNeeds = new Set<string>()
  const seenUsers = new Set<string>()

  function addFile(file: { path: string; content: string }) {
    if (!files.has(file.path)) files.set(file.path, file)
  }

  function addUser(actor: LinearActorFragment | null) {
    if (!actor || seenUsers.has(actor.id)) return
    seenUsers.add(actor.id)
    addFile(
      renderLinearEntity({
        preserveSourceUrls: true,
        directory: "users",
        type: "user",
        id: actor.id,
        title: linearActorName(actor) || actor.id,
        metadata: {
          active: actor.active,
          admin: actor.admin,
          guest: actor.guest,
          avatarUrl: actor.avatarUrl,
        },
      }),
    )
  }

  function addNeed(need: LoadedNeed, fallbackIssueId: string | null) {
    if (seenNeeds.has(need.id)) return
    seenNeeds.add(need.id)
    addFile(
      renderLinearEntity({
        preserveSourceUrls: true,
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
      }),
    )
    addUser(need.creator)
  }

  function addDocument(document: LoadedDocument) {
    if (documentIds.has(document.id)) return
    documentIds.add(document.id)
    addFile(
      renderLinearEntity({
        preserveSourceUrls: true,
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
      }),
    )
    addUser(document.creator)
  }

  function addIssue(loaded: LoadedIssue) {
    try {
      addFile(renderLinearIssue(loaded.issue, [], { preserveSourceUrls: true }))
      for (const actor of loaded.actors) addUser(actor)
      for (const need of loaded.needs) addNeed(need, loaded.issue.id)
    } catch (error) {
      failures.push({
        type: "issue",
        id: loaded.issue.id,
        message: errorMessage(error),
      })
    }
  }

  function addProject(project: LoadedProject) {
    addFile(
      renderLinearEntity({
        preserveSourceUrls: true,
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
      }),
    )
    for (const actor of project.actors) addUser(actor)
    for (const document of project.documents) addDocument(document)
    for (const need of project.needs) addNeed(need, null)
    projects.push({ id: project.id, teamIds: project.teamIds })
  }

  function addCycle(cycle: LoadedCycle, teamId: string) {
    addFile(
      renderLinearEntity({
        preserveSourceUrls: true,
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
      }),
    )
  }

  function addLabel(label: LoadedLabel) {
    addFile(
      renderLinearEntity({
        preserveSourceUrls: true,
        directory: "labels",
        type: "issue_label",
        id: label.id,
        title: label.name,
        body: label.description,
        metadata: { teamId: label.teamId, color: label.color },
      }),
    )
  }

  function addInitiative(
    initiative: Awaited<ReturnType<typeof loadInitiative>>,
  ) {
    addFile(
      renderLinearEntity({
        preserveSourceUrls: true,
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
      }),
    )
    for (const actor of initiative.actors) addUser(actor)
  }

  function addTeam(team: Awaited<ReturnType<typeof loadTeam>>) {
    addFile(
      renderLinearEntity({
        preserveSourceUrls: true,
        directory: "teams",
        type: "team",
        id: team.id,
        title: team.name,
        url: workspaceUrlKey
          ? `https://linear.app/${workspaceUrlKey}/team/${team.key}`
          : null,
        body: team.description,
        metadata: {
          key: team.key,
          parentId: team.parentId,
          createdAt: team.createdAt.toISOString(),
          updatedAt: team.updatedAt.toISOString(),
        },
      }),
    )
  }

  function finish(
    nextAfter: string | null,
    childIds: string[] = [],
  ): LinearMirrorPage {
    return {
      files: [...files.values()],
      nextAfter,
      failures,
      projects,
      documentIds: [...documentIds],
      childIds,
    }
  }

  return {
    failures,
    addTeam,
    addInitiative,
    addIssue,
    addProject,
    addDocument,
    addCycle,
    addLabel,
    finish,
  }
}

export async function fetchLinearMirrorPage(input: {
  env: Env
  connection: LinearConnection
  config: ParsedLinearRepoConfig
  onTokenRefresh?: LinearTokenRefreshHandler
  request: LinearMirrorPageRequest
}): Promise<LinearMirrorPage> {
  const includeNeeds = input.config.customerRequests === "limited"
  return withLinearClient(input, async (client) => {
    const page = createTextPage(input.connection.workspaceUrlKey)
    const request = input.request
    switch (request.kind) {
      case "team-record": {
        const team = await loadTeam(client, request.teamId)
        page.addTeam(team)
        return page.finish(null)
      }
      case "team-issues": {
        const loaded = await readTeamIssuePage(
          client,
          request.teamId,
          includeNeeds,
          request.after,
        )
        for (const issue of loaded.issues) page.addIssue(issue)
        return page.finish(loaded.nextAfter)
      }
      case "team-projects": {
        const loaded = await readTeamProjectPage(
          client,
          request.teamId,
          includeNeeds,
          request.after,
        )
        for (const project of loaded.projects) {
          try {
            page.addProject(project)
          } catch (error) {
            page.failures.push({
              type: "project",
              id: project.id,
              message: errorMessage(error),
            })
          }
        }
        return page.finish(loaded.nextAfter)
      }
      case "team-cycles": {
        const loaded = await readTeamCyclePage(
          client,
          request.teamId,
          request.after,
        )
        for (const cycle of loaded.cycles) page.addCycle(cycle, request.teamId)
        return page.finish(loaded.nextAfter)
      }
      case "team-labels": {
        const loaded = await readTeamLabelPage(
          client,
          request.teamId,
          request.after,
        )
        for (const label of loaded.labels) page.addLabel(label)
        return page.finish(loaded.nextAfter)
      }
      case "project-record": {
        const project = await loadProject(client, request.projectId, {
          includeNeeds,
          includeDocuments: true,
        })
        page.addProject(project)
        return page.finish(null)
      }
      case "project-issues": {
        const loaded = await readProjectIssuePage(
          client,
          request.projectId,
          includeNeeds,
          request.after,
        )
        for (const issue of loaded.issues) page.addIssue(issue)
        return page.finish(loaded.nextAfter)
      }
      case "initiative-record": {
        const initiative = await loadInitiative(client, request.initiativeId)
        page.addInitiative(initiative)
        return page.finish(null)
      }
      case "initiative-projects": {
        const loaded = await readInitiativeProjectPage(
          client,
          request.initiativeId,
          request.after,
        )
        return page.finish(loaded.nextAfter, loaded.projectIds)
      }
      case "initiative-documents": {
        const loaded = await readInitiativeDocumentPage(
          client,
          request.initiativeId,
          request.after,
        )
        return page.finish(loaded.nextAfter, loaded.documentIds)
      }
      case "document": {
        const document = await loadDocument(client, request.documentId)
        page.addDocument(document)
        return page.finish(null)
      }
    }
  })
}

function issuesCovered(
  teamIds: string[],
  completedTeams: Set<string>,
): boolean {
  return (
    teamIds.length > 0 && teamIds.every((teamId) => completedTeams.has(teamId))
  )
}

export async function walkLinearMirrorPages(input: {
  config: ParsedLinearRepoConfig
  runPage: (
    name: string,
    request: LinearMirrorPageRequest,
  ) => Promise<LinearMirrorPage>
}): Promise<LinearMirrorPage[]> {
  const pages: LinearMirrorPage[] = []
  const completedTeams = new Set<string>()
  const renderedProjects = new Map<string, string[]>()
  const renderedDocuments = new Set<string>()
  const startedTeams = new Set<string>()
  const startedProjects = new Set<string>()
  const startedInitiatives = new Set<string>()
  const startedDocuments = new Set<string>()

  function remember(page: LinearMirrorPage) {
    for (const project of page.projects) {
      if (!renderedProjects.has(project.id)) {
        renderedProjects.set(project.id, project.teamIds)
      }
    }
    for (const documentId of page.documentIds) {
      renderedDocuments.add(documentId)
    }
  }

  async function drain(
    prefix: string,
    request: (after: string | null) => LinearMirrorPageRequest,
  ): Promise<LinearMirrorPage[]> {
    const drained: LinearMirrorPage[] = []
    let after: string | null = null
    for (let index = 0; ; index += 1) {
      const cursor = after
      const page = await input.runPage(`${prefix}-${index}`, request(cursor))
      pages.push(page)
      drained.push(page)
      remember(page)
      if (!page.nextAfter) return drained
      after = page.nextAfter
    }
  }

  async function projectIssues(projectId: string, teamIds: string[]) {
    if (issuesCovered(teamIds, completedTeams)) return
    await drain(`project-${projectId}-issues`, (after) => ({
      kind: "project-issues",
      projectId,
      after,
    }))
  }

  async function projectRecord(projectId: string) {
    if (startedProjects.has(projectId)) return
    startedProjects.add(projectId)
    const knownTeams = renderedProjects.get(projectId)
    if (knownTeams) {
      await projectIssues(projectId, knownTeams)
      return
    }
    const record = await input.runPage(`project-${projectId}-record`, {
      kind: "project-record",
      projectId,
    })
    pages.push(record)
    remember(record)
    if (record.failures.length > 0) return
    await projectIssues(projectId, record.projects[0]?.teamIds ?? [])
  }

  async function documentRecord(documentId: string) {
    if (renderedDocuments.has(documentId) || startedDocuments.has(documentId)) {
      return
    }
    startedDocuments.add(documentId)
    const record = await input.runPage(`document-${documentId}`, {
      kind: "document",
      documentId,
    })
    pages.push(record)
    remember(record)
  }

  async function teamRecord(teamId: string) {
    if (startedTeams.has(teamId)) return
    startedTeams.add(teamId)
    const record = await input.runPage(`team-${teamId}-record`, {
      kind: "team-record",
      teamId,
    })
    pages.push(record)
    remember(record)
    if (record.failures.length > 0) return
    const issues = await drain(`team-${teamId}-issues`, (after) => ({
      kind: "team-issues",
      teamId,
      after,
    }))
    await drain(`team-${teamId}-projects`, (after) => ({
      kind: "team-projects",
      teamId,
      after,
    }))
    await drain(`team-${teamId}-cycles`, (after) => ({
      kind: "team-cycles",
      teamId,
      after,
    }))
    await drain(`team-${teamId}-labels`, (after) => ({
      kind: "team-labels",
      teamId,
      after,
    }))
    if (issues.every((page) => page.failures.length === 0)) {
      completedTeams.add(teamId)
    }
  }

  async function initiativeRecord(initiativeId: string) {
    if (startedInitiatives.has(initiativeId)) return
    startedInitiatives.add(initiativeId)
    const record = await input.runPage(`initiative-${initiativeId}-record`, {
      kind: "initiative-record",
      initiativeId,
    })
    pages.push(record)
    remember(record)
    if (record.failures.length > 0) return
    const projectPages = await drain(
      `initiative-${initiativeId}-projects`,
      (after) => ({
        kind: "initiative-projects",
        initiativeId,
        after,
      }),
    )
    for (const projectPage of projectPages) {
      for (const projectId of projectPage.childIds) {
        await projectRecord(projectId)
      }
    }
    const documentPages = await drain(
      `initiative-${initiativeId}-documents`,
      (after) => ({
        kind: "initiative-documents",
        initiativeId,
        after,
      }),
    )
    for (const documentPage of documentPages) {
      for (const documentId of documentPage.childIds) {
        await documentRecord(documentId)
      }
    }
  }

  const scopeOrder = {
    team: 0,
    project: 1,
    initiative: 2,
    document: 3,
  } as const
  const scopes = [...input.config.scopes].sort(
    (left, right) => scopeOrder[left.type] - scopeOrder[right.type],
  )
  for (const scope of scopes) {
    switch (scope.type) {
      case "team":
        await teamRecord(scope.externalId)
        break
      case "project":
        await projectRecord(scope.externalId)
        break
      case "initiative":
        await initiativeRecord(scope.externalId)
        break
      case "document":
        await documentRecord(scope.externalId)
        break
    }
  }
  return pages
}

export async function buildLinearMirror(input: {
  env: Env
  connection: LinearConnection
  config: ParsedLinearRepoConfig
  onTokenRefresh?: LinearTokenRefreshHandler
}): Promise<LinearMirrorBuildResult> {
  const pages = await walkLinearMirrorPages({
    config: input.config,
    runPage: (_name, request) =>
      fetchLinearMirrorPage({
        env: input.env,
        connection: input.connection,
        config: input.config,
        onTokenRefresh: input.onTokenRefresh,
        request,
      }),
  })
  const files = new Map<string, { path: string; content: string }>()
  const failures: LinearMirrorBuildResult["failures"] = []
  for (const page of pages) {
    failures.push(...page.failures)
    for (const file of page.files) {
      if (!files.has(file.path)) files.set(file.path, file)
    }
  }
  return {
    files: [...files.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    failures,
    preservePathPrefixes: [],
  }
}
