import type { LinearClient } from "@linear/sdk"
import type { LinearIssueForMirror } from "./converter.js"
import type {
  LinearActorFragment,
  LinearAttachmentNodeFragment,
  LinearCommentNodeFragment,
  LinearDocumentNodeFragment,
  LinearIssueCoreFragment,
  LinearLabelNodeFragment,
  LinearNeedNodeFragment,
  LinearProjectNodeFragment,
} from "./documents.generated.js"
import {
  CycleRecordDocument,
  DocumentRecordDocument,
  InitiativeDocumentsDocument,
  InitiativeProjectsDocument,
  InitiativeRecordDocument,
  InitiativeUpdatesPageDocument,
  IssueAttachmentsDocument,
  IssueCommentsDocument,
  IssueLabelRecordDocument,
  IssueLabelsPageDocument,
  IssueNeedsPageDocument,
  IssueProjectTeamsDocument,
  IssueRecordDocument,
  IssueRecordWithNeedsDocument,
  ProjectDocumentsPageDocument,
  ProjectIssuesDocument,
  ProjectIssuesWithNeedsDocument,
  ProjectNeedsPageDocument,
  ProjectRecordDocument,
  ProjectRecordWithNeedsDocument,
  ProjectTeamsPageDocument,
  ProjectUpdatesPageDocument,
  TeamCyclesDocument,
  TeamIssuesDocument,
  TeamIssuesWithNeedsDocument,
  TeamLabelsDocument,
  TeamProjectsDocument,
  TeamProjectsWithNeedsDocument,
  TeamRecordDocument,
  UserRecordDocument,
} from "./documents.generated.js"
import { linearGraphql } from "./graphql.js"

type Page<T> = {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

type IssueNode = LinearIssueCoreFragment & {
  needs?: Page<LinearNeedNodeFragment>
}

type ProjectNode = LinearProjectNodeFragment & {
  needs?: Page<LinearNeedNodeFragment>
}

export type LoadedNeed = {
  id: string
  url: string | null
  body: string | null
  content: string | null
  priority: number
  customerId: string | null
  projectId: string | null
  issueId: string | null
  createdAt: Date
  updatedAt: Date
  creator: LinearActorFragment | null
}

export type LoadedIssue = {
  issue: LinearIssueForMirror
  needs: LoadedNeed[]
  actors: LinearActorFragment[]
  projectTeamIds: string[]
}

export type LoadedDocument = {
  id: string
  title: string
  url: string
  content: string | null
  projectId: string | null
  projectTeamIds: string[]
  createdAt: Date
  updatedAt: Date
  creator: LinearActorFragment | null
}

export type LoadedUpdate = {
  body: string
  health: string
  createdAt: Date
}

export type LoadedProject = {
  id: string
  name: string
  url: string
  content: string | null
  description: string
  statusId: string
  leadId: string | null
  priorityLabel: string
  progress: number
  startDate: string | null
  targetDate: string | null
  createdAt: Date
  updatedAt: Date
  teamIds: string[]
  updates: LoadedUpdate[]
  documents: LoadedDocument[]
  needs: LoadedNeed[]
  actors: LinearActorFragment[]
}

export type LoadedTeam = {
  id: string
  name: string
  key: string
  description: string | null
  parentId: string | null
  createdAt: Date
  updatedAt: Date
}

export type LoadedCycle = {
  id: string
  name: string | null
  number: number
  teamId: string
  startsAt: Date
  endsAt: Date
  completedAt: Date | null
}

export type LoadedLabel = {
  id: string
  name: string
  description: string | null
  color: string
  teamId: string | null
}

export type LoadedInitiative = {
  id: string
  name: string
  url: string
  content: string | null
  description: string | null
  status: string
  health: string | null
  ownerId: string | null
  parentInitiativeId: string | null
  targetDate: string | null
  createdAt: Date
  updatedAt: Date
  updates: LoadedUpdate[]
  actors: LinearActorFragment[]
}

export async function loadTeam(
  client: LinearClient,
  id: string,
): Promise<LoadedTeam> {
  const data = await linearGraphql(client, TeamRecordDocument, { id })
  return {
    id: data.team.id,
    name: data.team.name,
    key: data.team.key,
    description: data.team.description,
    parentId: data.team.parent?.id ?? null,
    createdAt: new Date(data.team.createdAt),
    updatedAt: new Date(data.team.updatedAt),
  }
}

export async function readTeamIssuePage(
  client: LinearClient,
  teamId: string,
  includeNeeds: boolean,
  after: string | null,
): Promise<{ issues: LoadedIssue[]; nextAfter: string | null }> {
  const page = includeNeeds
    ? (
        await linearGraphql(client, TeamIssuesWithNeedsDocument, {
          id: teamId,
          after,
        })
      ).team.issues
    : (await linearGraphql(client, TeamIssuesDocument, { id: teamId, after }))
        .team.issues
  const issues: LoadedIssue[] = []
  for (const node of page.nodes) {
    issues.push(await loadIssueNode(client, node, includeNeeds))
  }
  return { issues, nextAfter: nextCursor(page) }
}

export async function loadTeamIssues(
  client: LinearClient,
  teamId: string,
  includeNeeds: boolean,
): Promise<LoadedIssue[]> {
  const issues: LoadedIssue[] = []
  let after: string | null = null
  for (;;) {
    const page = await readTeamIssuePage(client, teamId, includeNeeds, after)
    issues.push(...page.issues)
    if (!page.nextAfter) return issues
    after = page.nextAfter
  }
}

export async function readTeamProjectPage(
  client: LinearClient,
  teamId: string,
  includeNeeds: boolean,
  after: string | null,
): Promise<{ projects: LoadedProject[]; nextAfter: string | null }> {
  const page = includeNeeds
    ? (
        await linearGraphql(client, TeamProjectsWithNeedsDocument, {
          id: teamId,
          after,
        })
      ).team.projects
    : (
        await linearGraphql(client, TeamProjectsDocument, {
          id: teamId,
          after,
        })
      ).team.projects
  const projects: LoadedProject[] = []
  for (const node of page.nodes) {
    projects.push(
      await loadProjectNode(client, node, {
        includeNeeds,
        includeDocuments: true,
      }),
    )
  }
  return { projects, nextAfter: nextCursor(page) }
}

export async function loadTeamProjects(
  client: LinearClient,
  teamId: string,
  includeNeeds: boolean,
): Promise<LoadedProject[]> {
  const projects: LoadedProject[] = []
  let after: string | null = null
  for (;;) {
    const page = await readTeamProjectPage(client, teamId, includeNeeds, after)
    projects.push(...page.projects)
    if (!page.nextAfter) return projects
    after = page.nextAfter
  }
}

export async function readTeamCyclePage(
  client: LinearClient,
  teamId: string,
  after: string | null,
): Promise<{ cycles: LoadedCycle[]; nextAfter: string | null }> {
  const page = (
    await linearGraphql(client, TeamCyclesDocument, { id: teamId, after })
  ).team.cycles
  return {
    cycles: page.nodes.map((cycle) => ({
      id: cycle.id,
      name: cycle.name,
      number: cycle.number,
      teamId,
      startsAt: new Date(cycle.startsAt),
      endsAt: new Date(cycle.endsAt),
      completedAt: cycle.completedAt ? new Date(cycle.completedAt) : null,
    })),
    nextAfter: nextCursor(page),
  }
}

export async function loadTeamCycles(
  client: LinearClient,
  teamId: string,
): Promise<LoadedCycle[]> {
  const cycles: LoadedCycle[] = []
  let after: string | null = null
  for (;;) {
    const page = await readTeamCyclePage(client, teamId, after)
    cycles.push(...page.cycles)
    if (!page.nextAfter) return cycles
    after = page.nextAfter
  }
}

export async function readTeamLabelPage(
  client: LinearClient,
  teamId: string,
  after: string | null,
): Promise<{ labels: LoadedLabel[]; nextAfter: string | null }> {
  const page = (
    await linearGraphql(client, TeamLabelsDocument, { id: teamId, after })
  ).team.labels
  return {
    labels: page.nodes.map((label) => mapLabel(label, teamId)),
    nextAfter: nextCursor(page),
  }
}

export async function loadTeamLabels(
  client: LinearClient,
  teamId: string,
): Promise<LoadedLabel[]> {
  const labels: LoadedLabel[] = []
  let after: string | null = null
  for (;;) {
    const page = await readTeamLabelPage(client, teamId, after)
    labels.push(...page.labels)
    if (!page.nextAfter) return labels
    after = page.nextAfter
  }
}

export async function loadProject(
  client: LinearClient,
  id: string,
  options: { includeNeeds: boolean; includeDocuments: boolean },
): Promise<LoadedProject> {
  if (options.includeNeeds) {
    const data = await linearGraphql(client, ProjectRecordWithNeedsDocument, {
      id,
    })
    return loadProjectNode(client, data.project, options)
  }
  const data = await linearGraphql(client, ProjectRecordDocument, { id })
  return loadProjectNode(client, data.project, options)
}

export async function readProjectIssuePage(
  client: LinearClient,
  projectId: string,
  includeNeeds: boolean,
  after: string | null,
): Promise<{ issues: LoadedIssue[]; nextAfter: string | null }> {
  const page = includeNeeds
    ? (
        await linearGraphql(client, ProjectIssuesWithNeedsDocument, {
          id: projectId,
          after,
        })
      ).project.issues
    : (
        await linearGraphql(client, ProjectIssuesDocument, {
          id: projectId,
          after,
        })
      ).project.issues
  const issues: LoadedIssue[] = []
  for (const node of page.nodes) {
    issues.push(await loadIssueNode(client, node, includeNeeds))
  }
  return { issues, nextAfter: nextCursor(page) }
}

export async function loadProjectIssues(
  client: LinearClient,
  projectId: string,
  includeNeeds: boolean,
): Promise<LoadedIssue[]> {
  const issues: LoadedIssue[] = []
  let after: string | null = null
  for (;;) {
    const page = await readProjectIssuePage(
      client,
      projectId,
      includeNeeds,
      after,
    )
    issues.push(...page.issues)
    if (!page.nextAfter) return issues
    after = page.nextAfter
  }
}

export async function loadIssue(
  client: LinearClient,
  id: string,
  includeNeeds: boolean,
): Promise<LoadedIssue> {
  if (includeNeeds) {
    const data = await linearGraphql(client, IssueRecordWithNeedsDocument, {
      id,
    })
    return loadIssueNode(client, data.issue, true)
  }
  const data = await linearGraphql(client, IssueRecordDocument, { id })
  return loadIssueNode(client, data.issue, false)
}

export async function loadDocument(
  client: LinearClient,
  id: string,
): Promise<LoadedDocument> {
  const data = await linearGraphql(client, DocumentRecordDocument, { id })
  return mapDocumentRecord(client, data.document)
}

export async function loadInitiative(
  client: LinearClient,
  id: string,
): Promise<LoadedInitiative> {
  const data = await linearGraphql(client, InitiativeRecordDocument, { id })
  const initiative = data.initiative
  const updates = await completeConnection(
    initiative.initiativeUpdates,
    async (after) => {
      const page = await linearGraphql(client, InitiativeUpdatesPageDocument, {
        id,
        after,
      })
      return page.initiative.initiativeUpdates
    },
  )
  const actors = initiative.owner ? [initiative.owner] : []
  return {
    id: initiative.id,
    name: initiative.name,
    url: initiative.url,
    content: initiative.content,
    description: initiative.description,
    status: initiative.status,
    health: initiative.health,
    ownerId: initiative.owner?.id ?? null,
    parentInitiativeId: initiative.parentInitiative?.id ?? null,
    targetDate: initiative.targetDate,
    createdAt: new Date(initiative.createdAt),
    updatedAt: new Date(initiative.updatedAt),
    updates: updates.map(mapUpdate),
    actors,
  }
}

export async function readInitiativeProjectPage(
  client: LinearClient,
  id: string,
  after: string | null,
): Promise<{ projectIds: string[]; nextAfter: string | null }> {
  const page = (
    await linearGraphql(client, InitiativeProjectsDocument, { id, after })
  ).initiative.projects
  return {
    projectIds: page.nodes.map((project) => project.id),
    nextAfter: nextCursor(page),
  }
}

export async function loadInitiativeProjectIds(
  client: LinearClient,
  id: string,
): Promise<string[]> {
  const projectIds: string[] = []
  let after: string | null = null
  for (;;) {
    const page = await readInitiativeProjectPage(client, id, after)
    projectIds.push(...page.projectIds)
    if (!page.nextAfter) return projectIds
    after = page.nextAfter
  }
}

export async function readInitiativeDocumentPage(
  client: LinearClient,
  id: string,
  after: string | null,
): Promise<{ documentIds: string[]; nextAfter: string | null }> {
  const page = (
    await linearGraphql(client, InitiativeDocumentsDocument, { id, after })
  ).initiative.documents
  return {
    documentIds: page.nodes.map((document) => document.id),
    nextAfter: nextCursor(page),
  }
}

export async function loadInitiativeDocumentIds(
  client: LinearClient,
  id: string,
): Promise<string[]> {
  const documentIds: string[] = []
  let after: string | null = null
  for (;;) {
    const page = await readInitiativeDocumentPage(client, id, after)
    documentIds.push(...page.documentIds)
    if (!page.nextAfter) return documentIds
    after = page.nextAfter
  }
}

export async function loadCycle(
  client: LinearClient,
  id: string,
): Promise<LoadedCycle> {
  const data = await linearGraphql(client, CycleRecordDocument, { id })
  const cycle = data.cycle
  return {
    id: cycle.id,
    name: cycle.name,
    number: cycle.number,
    teamId: cycle.team.id,
    startsAt: new Date(cycle.startsAt),
    endsAt: new Date(cycle.endsAt),
    completedAt: cycle.completedAt ? new Date(cycle.completedAt) : null,
  }
}

export async function loadIssueLabel(
  client: LinearClient,
  id: string,
): Promise<LoadedLabel> {
  const data = await linearGraphql(client, IssueLabelRecordDocument, { id })
  return mapLabel(data.issueLabel, data.issueLabel.team?.id ?? null)
}

export async function loadUser(
  client: LinearClient,
  id: string,
): Promise<LinearActorFragment> {
  const data = await linearGraphql(client, UserRecordDocument, { id })
  return data.user
}

export function linearActorName(
  actor: { displayName: string; name: string } | null | undefined,
): string | null {
  if (!actor) return null
  return actor.displayName || actor.name || null
}

async function loadIssueNode(
  client: LinearClient,
  issue: IssueNode,
  includeNeeds: boolean,
): Promise<LoadedIssue> {
  const comments = await completeConnection(issue.comments, async (after) => {
    const data = await linearGraphql(client, IssueCommentsDocument, {
      id: issue.id,
      after,
    })
    return data.issue.comments
  })
  const attachments = await completeConnection(
    issue.attachments,
    async (after) => {
      const data = await linearGraphql(client, IssueAttachmentsDocument, {
        id: issue.id,
        after,
      })
      return data.issue.attachments
    },
  )
  const labels = await completeConnection(issue.labels, async (after) => {
    const data = await linearGraphql(client, IssueLabelsPageDocument, {
      id: issue.id,
      after,
    })
    return data.issue.labels
  })
  const needs =
    includeNeeds && issue.needs
      ? await completeConnection(issue.needs, async (after) => {
          const data = await linearGraphql(client, IssueNeedsPageDocument, {
            id: issue.id,
            after,
          })
          return data.issue.needs
        })
      : []
  const project = issue.project
  const projectTeams = project
    ? await completeConnection(project.teams, async (after) => {
        const data = await linearGraphql(client, IssueProjectTeamsDocument, {
          id: issue.id,
          after,
        })
        return data.issue.project?.teams
      })
    : []
  const actors = [
    issue.assignee,
    issue.creator,
    ...comments.map((comment) => comment.user),
    ...needs.map((need) => need.creator),
  ].filter((actor): actor is LinearActorFragment => actor != null)
  const mapped: LinearIssueForMirror = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    priorityLabel: issue.priorityLabel,
    state: issue.state.name,
    teamId: issue.team.id,
    teamKey: issue.team.key,
    teamName: issue.team.name,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    cycleId: issue.cycle?.id ?? null,
    cycleName: issue.cycle?.name ?? null,
    assigneeId: issue.assignee?.id ?? null,
    assignee: linearActorName(issue.assignee),
    creatorId: issue.creator?.id ?? null,
    creator: linearActorName(issue.creator),
    labels: labels.map((label) => ({ id: label.id, name: label.name })),
    createdAt: new Date(issue.createdAt),
    updatedAt: new Date(issue.updatedAt),
    comments: comments.map((comment) => mapComment(comment)),
    attachments: attachments.map((attachment) => mapAttachment(attachment)),
  }
  return {
    issue: mapped,
    needs: needs.map((need) =>
      mapNeed(need, { issueId: issue.id, projectId: project?.id ?? null }),
    ),
    actors,
    projectTeamIds: projectTeams.map((team) => team.id),
  }
}

async function loadProjectNode(
  client: LinearClient,
  project: ProjectNode,
  options: { includeNeeds: boolean; includeDocuments: boolean },
): Promise<LoadedProject> {
  const teams = await completeConnection(project.teams, async (after) => {
    const data = await linearGraphql(client, ProjectTeamsPageDocument, {
      id: project.id,
      after,
    })
    return data.project.teams
  })
  const updates = await completeConnection(
    project.projectUpdates,
    async (after) => {
      const data = await linearGraphql(client, ProjectUpdatesPageDocument, {
        id: project.id,
        after,
      })
      return data.project.projectUpdates
    },
  )
  const documents = options.includeDocuments
    ? await completeConnection(project.documents, async (after) => {
        const data = await linearGraphql(client, ProjectDocumentsPageDocument, {
          id: project.id,
          after,
        })
        return data.project.documents
      })
    : []
  const needs =
    options.includeNeeds && project.needs
      ? await completeConnection(project.needs, async (after) => {
          const data = await linearGraphql(client, ProjectNeedsPageDocument, {
            id: project.id,
            after,
          })
          return data.project.needs
        })
      : []
  const mappedDocuments = documents.map((document) => mapDocument(document, []))
  const actors = [
    project.lead,
    ...mappedDocuments.map((document) => document.creator),
    ...needs.map((need) => need.creator),
  ].filter((actor): actor is LinearActorFragment => actor != null)
  return {
    id: project.id,
    name: project.name,
    url: project.url,
    content: project.content,
    description: project.description,
    statusId: project.status.id,
    leadId: project.lead?.id ?? null,
    priorityLabel: project.priorityLabel,
    progress: project.progress,
    startDate: project.startDate,
    targetDate: project.targetDate,
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt),
    teamIds: teams.map((team) => team.id),
    updates: updates.map(mapUpdate),
    documents: mappedDocuments,
    needs: needs.map((need) => mapNeed(need, { projectId: project.id })),
    actors,
  }
}

async function mapDocumentRecord(
  client: LinearClient,
  document: LinearDocumentNodeFragment & {
    project: {
      id: string
      teams: Page<{ id: string }>
    } | null
  },
): Promise<LoadedDocument> {
  const project = document.project
  const projectTeamIds = project
    ? (
        await completeConnection(project.teams, async (after) => {
          const data = await linearGraphql(client, ProjectTeamsPageDocument, {
            id: project.id,
            after,
          })
          return data.project.teams
        })
      ).map((team) => team.id)
    : []
  return mapDocument(document, projectTeamIds)
}

function mapDocument(
  document: LinearDocumentNodeFragment,
  projectTeamIds: string[],
): LoadedDocument {
  return {
    id: document.id,
    title: document.title,
    url: document.url,
    content: document.content,
    projectId: document.project?.id ?? null,
    projectTeamIds,
    createdAt: new Date(document.createdAt),
    updatedAt: new Date(document.updatedAt),
    creator: document.creator,
  }
}

function mapLabel(
  label: LinearLabelNodeFragment,
  teamId: string | null,
): LoadedLabel {
  return {
    id: label.id,
    name: label.name,
    description: label.description,
    color: label.color,
    teamId,
  }
}

function mapComment(
  comment: LinearCommentNodeFragment,
): LinearIssueForMirror["comments"][number] {
  return {
    id: comment.id,
    body: comment.body,
    userId: comment.user?.id ?? null,
    userName: linearActorName(comment.user),
    createdAt: new Date(comment.createdAt),
    updatedAt: new Date(comment.updatedAt),
  }
}

function mapAttachment(
  attachment: LinearAttachmentNodeFragment,
): LinearIssueForMirror["attachments"][number] {
  return {
    id: attachment.id,
    title: attachment.title,
    url: attachment.url,
    sourceType: attachment.sourceType,
    metadata: attachmentMetadata(attachment.metadata),
  }
}

function mapNeed(
  need: LinearNeedNodeFragment,
  fallback: { issueId?: string | null; projectId?: string | null },
): LoadedNeed {
  return {
    id: need.id,
    url: need.url,
    body: need.body,
    content: need.content,
    priority: need.priority,
    customerId: need.customer?.id ?? null,
    projectId: need.project?.id ?? fallback.projectId ?? null,
    issueId: need.issue?.id ?? fallback.issueId ?? null,
    createdAt: new Date(need.createdAt),
    updatedAt: new Date(need.updatedAt),
    creator: need.creator,
  }
}

function mapUpdate(update: {
  body: string
  health: string
  createdAt: string
}): LoadedUpdate {
  return {
    body: update.body,
    health: update.health,
    createdAt: new Date(update.createdAt),
  }
}

function attachmentMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null
  return { ...metadata }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nextCursor(page: Page<unknown> | null | undefined): string | null {
  if (!page?.pageInfo.hasNextPage || !page.pageInfo.endCursor) return null
  return page.pageInfo.endCursor
}

async function completeConnection<T>(
  connection: Page<T>,
  load: (after: string) => Promise<Page<T> | null | undefined>,
): Promise<T[]> {
  const nodes = [...connection.nodes]
  let pageInfo = connection.pageInfo
  while (pageInfo.hasNextPage && pageInfo.endCursor) {
    const next = await load(pageInfo.endCursor)
    if (!next) return nodes
    nodes.push(...next.nodes)
    pageInfo = next.pageInfo
  }
  return nodes
}
