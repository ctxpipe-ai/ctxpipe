import type { TypedDocumentNode } from "@graphql-typed-document-node/core"
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

function gql<TData, TVariables extends Record<string, unknown>>(
  client: LinearClient,
  accessToken: string,
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
): Promise<TData> {
  return linearGraphql(client, document, variables, accessToken)
}

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

export type LinearFollowConnection =
  | "issue-comments"
  | "issue-attachments"
  | "issue-labels"
  | "issue-needs"
  | "issue-project-teams"
  | "project-teams"
  | "project-updates"
  | "project-documents"
  | "project-needs"
  | "initiative-updates"
  | "document-project-teams"

export type LinearFollow = {
  connection: LinearFollowConnection
  entityId: string
  queryId: string
  after: string
}

export type LinearFollowPage =
  | {
      connection: "issue-comments"
      comments: LinearIssueForMirror["comments"]
      actors: LinearActorFragment[]
      nextAfter: string | null
    }
  | {
      connection: "issue-attachments"
      attachments: LinearIssueForMirror["attachments"]
      nextAfter: string | null
    }
  | {
      connection: "issue-labels"
      labels: Array<{ id: string; name: string }>
      nextAfter: string | null
    }
  | {
      connection: "issue-needs" | "project-needs"
      needs: LoadedNeed[]
      actors: LinearActorFragment[]
      nextAfter: string | null
    }
  | {
      connection:
        | "issue-project-teams"
        | "project-teams"
        | "document-project-teams"
      teamIds: string[]
      nextAfter: string | null
    }
  | {
      connection: "project-updates" | "initiative-updates"
      updates: LoadedUpdate[]
      nextAfter: string | null
    }
  | {
      connection: "project-documents"
      documents: LoadedDocument[]
      actors: LinearActorFragment[]
      nextAfter: string | null
    }

type IssueRead = { loaded: LoadedIssue; follows: LinearFollow[] }
type ProjectRead = { loaded: LoadedProject; follows: LinearFollow[] }

export async function loadTeam(
  client: LinearClient,
  accessToken: string,
  id: string,
): Promise<LoadedTeam> {
  const data = await gql(client, accessToken, TeamRecordDocument, { id })
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
  accessToken: string,
  teamId: string,
  includeNeeds: boolean,
  after: string | null,
): Promise<{ issues: IssueRead[]; nextAfter: string | null }> {
  const page = includeNeeds
    ? (
        await gql(client, accessToken, TeamIssuesWithNeedsDocument, {
          id: teamId,
          after,
        })
      ).team.issues
    : (
        await gql(client, accessToken, TeamIssuesDocument, {
          id: teamId,
          after,
        })
      ).team.issues
  return {
    issues: page.nodes.map((node) => loadIssueNode(node, includeNeeds)),
    nextAfter: nextCursor(page),
  }
}

export async function readTeamProjectPage(
  client: LinearClient,
  accessToken: string,
  teamId: string,
  includeNeeds: boolean,
  after: string | null,
): Promise<{ projects: ProjectRead[]; nextAfter: string | null }> {
  const page = includeNeeds
    ? (
        await gql(client, accessToken, TeamProjectsWithNeedsDocument, {
          id: teamId,
          after,
        })
      ).team.projects
    : (
        await gql(client, accessToken, TeamProjectsDocument, {
          id: teamId,
          after,
        })
      ).team.projects
  return {
    projects: page.nodes.map((node) =>
      loadProjectNode(node, { includeNeeds, includeDocuments: true }),
    ),
    nextAfter: nextCursor(page),
  }
}

export async function readTeamCyclePage(
  client: LinearClient,
  accessToken: string,
  teamId: string,
  after: string | null,
): Promise<{ cycles: LoadedCycle[]; nextAfter: string | null }> {
  const page = (
    await gql(client, accessToken, TeamCyclesDocument, { id: teamId, after })
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

export async function readTeamLabelPage(
  client: LinearClient,
  accessToken: string,
  teamId: string,
  after: string | null,
): Promise<{ labels: LoadedLabel[]; nextAfter: string | null }> {
  const page = (
    await gql(client, accessToken, TeamLabelsDocument, { id: teamId, after })
  ).team.labels
  return {
    labels: page.nodes.map((label) => mapLabel(label, teamId)),
    nextAfter: nextCursor(page),
  }
}

export async function readProjectRecord(
  client: LinearClient,
  accessToken: string,
  id: string,
  options: { includeNeeds: boolean; includeDocuments: boolean },
): Promise<ProjectRead> {
  if (options.includeNeeds) {
    return loadProjectNode(
      (await gql(client, accessToken, ProjectRecordWithNeedsDocument, { id }))
        .project,
      options,
    )
  }
  return loadProjectNode(
    (await gql(client, accessToken, ProjectRecordDocument, { id })).project,
    options,
  )
}

export async function loadProject(
  client: LinearClient,
  accessToken: string,
  id: string,
  options: { includeNeeds: boolean; includeDocuments: boolean },
): Promise<LoadedProject> {
  const read = await readProjectRecord(client, accessToken, id, options)
  return absorb(
    client,
    accessToken,
    read.loaded,
    read.follows,
    (loaded, page) => applyLinearFollowToProject(loaded, page),
  )
}

export async function readProjectIssuePage(
  client: LinearClient,
  accessToken: string,
  projectId: string,
  includeNeeds: boolean,
  after: string | null,
): Promise<{ issues: IssueRead[]; nextAfter: string | null }> {
  const page = includeNeeds
    ? (
        await gql(client, accessToken, ProjectIssuesWithNeedsDocument, {
          id: projectId,
          after,
        })
      ).project.issues
    : (
        await gql(client, accessToken, ProjectIssuesDocument, {
          id: projectId,
          after,
        })
      ).project.issues
  return {
    issues: page.nodes.map((node) => loadIssueNode(node, includeNeeds)),
    nextAfter: nextCursor(page),
  }
}

export async function loadIssue(
  client: LinearClient,
  accessToken: string,
  id: string,
  includeNeeds: boolean,
): Promise<LoadedIssue> {
  const read = includeNeeds
    ? loadIssueNode(
        (await gql(client, accessToken, IssueRecordWithNeedsDocument, { id }))
          .issue,
        true,
      )
    : loadIssueNode(
        (await gql(client, accessToken, IssueRecordDocument, { id })).issue,
        false,
      )
  return absorb(
    client,
    accessToken,
    read.loaded,
    read.follows,
    (loaded, page) => applyLinearFollowToIssue(loaded, page),
  )
}

export async function readDocumentRecord(
  client: LinearClient,
  accessToken: string,
  id: string,
): Promise<{ loaded: LoadedDocument; follows: LinearFollow[] }> {
  const data = await gql(client, accessToken, DocumentRecordDocument, { id })
  return mapDocumentRecord(data.document)
}

export async function loadDocument(
  client: LinearClient,
  accessToken: string,
  id: string,
): Promise<LoadedDocument> {
  const read = await readDocumentRecord(client, accessToken, id)
  return absorb(
    client,
    accessToken,
    read.loaded,
    read.follows,
    (loaded, page) => applyLinearFollowToDocument(loaded, page),
  )
}

export async function readInitiativeRecord(
  client: LinearClient,
  accessToken: string,
  id: string,
): Promise<{ loaded: LoadedInitiative; follows: LinearFollow[] }> {
  const data = await gql(client, accessToken, InitiativeRecordDocument, { id })
  return mapInitiativeRecord(data.initiative)
}

export async function loadInitiative(
  client: LinearClient,
  accessToken: string,
  id: string,
): Promise<LoadedInitiative> {
  const read = await readInitiativeRecord(client, accessToken, id)
  return absorb(
    client,
    accessToken,
    read.loaded,
    read.follows,
    (loaded, page) => applyLinearFollowToInitiative(loaded, page),
  )
}

export async function readInitiativeProjectPage(
  client: LinearClient,
  accessToken: string,
  id: string,
  after: string | null,
): Promise<{ projectIds: string[]; nextAfter: string | null }> {
  const page = (
    await gql(client, accessToken, InitiativeProjectsDocument, { id, after })
  ).initiative.projects
  return {
    projectIds: page.nodes.map((project) => project.id),
    nextAfter: nextCursor(page),
  }
}

export async function loadInitiativeProjectIds(
  client: LinearClient,
  accessToken: string,
  id: string,
): Promise<string[]> {
  const projectIds: string[] = []
  let after: string | null = null
  for (;;) {
    const page = await readInitiativeProjectPage(client, accessToken, id, after)
    projectIds.push(...page.projectIds)
    if (!page.nextAfter) return projectIds
    after = page.nextAfter
  }
}

export async function readInitiativeDocumentPage(
  client: LinearClient,
  accessToken: string,
  id: string,
  after: string | null,
): Promise<{ documentIds: string[]; nextAfter: string | null }> {
  const page = (
    await gql(client, accessToken, InitiativeDocumentsDocument, { id, after })
  ).initiative.documents
  return {
    documentIds: page.nodes.map((document) => document.id),
    nextAfter: nextCursor(page),
  }
}

export async function loadInitiativeDocumentIds(
  client: LinearClient,
  accessToken: string,
  id: string,
): Promise<string[]> {
  const documentIds: string[] = []
  let after: string | null = null
  for (;;) {
    const page = await readInitiativeDocumentPage(
      client,
      accessToken,
      id,
      after,
    )
    documentIds.push(...page.documentIds)
    if (!page.nextAfter) return documentIds
    after = page.nextAfter
  }
}

export async function loadCycle(
  client: LinearClient,
  accessToken: string,
  id: string,
): Promise<LoadedCycle> {
  const data = await gql(client, accessToken, CycleRecordDocument, { id })
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
  accessToken: string,
  id: string,
): Promise<LoadedLabel> {
  const data = await gql(client, accessToken, IssueLabelRecordDocument, { id })
  return mapLabel(data.issueLabel, data.issueLabel.team?.id ?? null)
}

export async function loadUser(
  client: LinearClient,
  accessToken: string,
  id: string,
): Promise<LinearActorFragment> {
  const data = await gql(client, accessToken, UserRecordDocument, { id })
  return data.user
}

export function linearActorName(
  actor: { displayName: string; name: string } | null | undefined,
): string | null {
  if (!actor) return null
  return actor.displayName || actor.name || null
}

function loadIssueNode(issue: IssueNode, includeNeeds: boolean): IssueRead {
  const project = issue.project
  const comments = issue.comments.nodes
  const attachments = issue.attachments.nodes
  const labels = issue.labels.nodes
  const needs = includeNeeds && issue.needs ? issue.needs.nodes : []
  const projectTeams = project?.teams.nodes ?? []
  const follows = [
    ...continued("issue-comments", issue.id, issue.id, issue.comments),
    ...continued("issue-attachments", issue.id, issue.id, issue.attachments),
    ...continued("issue-labels", issue.id, issue.id, issue.labels),
    ...(includeNeeds
      ? continued("issue-needs", issue.id, issue.id, issue.needs)
      : []),
    ...(project
      ? continued("issue-project-teams", issue.id, issue.id, project.teams)
      : []),
  ]
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
    loaded: {
      issue: mapped,
      needs: needs.map((need) =>
        mapNeed(need, { issueId: issue.id, projectId: project?.id ?? null }),
      ),
      actors,
      projectTeamIds: projectTeams.map((team) => team.id),
    },
    follows,
  }
}

function loadProjectNode(
  project: ProjectNode,
  options: { includeNeeds: boolean; includeDocuments: boolean },
): ProjectRead {
  const teams = project.teams.nodes
  const updates = project.projectUpdates.nodes
  const documents = options.includeDocuments ? project.documents.nodes : []
  const needs = options.includeNeeds && project.needs ? project.needs.nodes : []
  const follows = [
    ...continued("project-teams", project.id, project.id, project.teams),
    ...continued(
      "project-updates",
      project.id,
      project.id,
      project.projectUpdates,
    ),
    ...(options.includeDocuments
      ? continued(
          "project-documents",
          project.id,
          project.id,
          project.documents,
        )
      : []),
    ...(options.includeNeeds
      ? continued("project-needs", project.id, project.id, project.needs)
      : []),
  ]
  const mappedDocuments = documents.map((document) => mapDocument(document, []))
  const actors = [
    project.lead,
    ...mappedDocuments.map((document) => document.creator),
    ...needs.map((need) => need.creator),
  ].filter((actor): actor is LinearActorFragment => actor != null)
  return {
    loaded: {
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
    },
    follows,
  }
}

function mapDocumentRecord(
  document: LinearDocumentNodeFragment & {
    project: {
      id: string
      teams: Page<{ id: string }>
    } | null
  },
): { loaded: LoadedDocument; follows: LinearFollow[] } {
  const project = document.project
  const follows = project
    ? continued(
        "document-project-teams",
        document.id,
        project.id,
        project.teams,
      )
    : []
  return {
    loaded: mapDocument(
      document,
      project?.teams.nodes.map((team) => team.id) ?? [],
    ),
    follows,
  }
}

function mapInitiativeRecord(initiative: {
  id: string
  name: string
  url: string
  content: string | null
  description: string | null
  status: string
  health: string | null
  targetDate: string | null
  createdAt: string
  updatedAt: string
  parentInitiative: { id: string } | null
  owner: LinearActorFragment | null
  initiativeUpdates: Page<{
    body: string
    health: string
    createdAt: string
  }>
}): { loaded: LoadedInitiative; follows: LinearFollow[] } {
  return {
    loaded: {
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
      updates: initiative.initiativeUpdates.nodes.map(mapUpdate),
      actors: initiative.owner ? [initiative.owner] : [],
    },
    follows: continued(
      "initiative-updates",
      initiative.id,
      initiative.id,
      initiative.initiativeUpdates,
    ),
  }
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

function continued(
  connection: LinearFollowConnection,
  entityId: string,
  queryId: string,
  page: Page<unknown> | null | undefined,
): LinearFollow[] {
  const after = nextCursor(page)
  return after ? [{ connection, entityId, queryId, after }] : []
}

function presentActors(
  actors: Array<LinearActorFragment | null | undefined>,
): LinearActorFragment[] {
  return actors.filter((actor): actor is LinearActorFragment => actor != null)
}

async function absorb<T>(
  client: LinearClient,
  accessToken: string,
  loaded: T,
  follows: LinearFollow[],
  apply: (loaded: T, page: LinearFollowPage) => T,
): Promise<T> {
  let current = loaded
  let queue = [...follows]
  while (queue.length > 0) {
    const follow = queue[0]
    if (!follow) break
    queue = queue.slice(1)
    const page = await readLinearFollow(client, accessToken, follow)
    current = apply(current, page)
    if (page.nextAfter) queue = [{ ...follow, after: page.nextAfter }, ...queue]
  }
  return current
}

export async function readLinearFollow(
  client: LinearClient,
  accessToken: string,
  follow: LinearFollow,
): Promise<LinearFollowPage> {
  switch (follow.connection) {
    case "issue-comments": {
      const page = (
        await gql(client, accessToken, IssueCommentsDocument, {
          id: follow.queryId,
          after: follow.after,
        })
      ).issue.comments
      return {
        connection: follow.connection,
        comments: page.nodes.map((comment) => mapComment(comment)),
        actors: presentActors(page.nodes.map((comment) => comment.user)),
        nextAfter: nextCursor(page),
      }
    }
    case "issue-attachments": {
      const page = (
        await gql(client, accessToken, IssueAttachmentsDocument, {
          id: follow.queryId,
          after: follow.after,
        })
      ).issue.attachments
      return {
        connection: follow.connection,
        attachments: page.nodes.map((attachment) => mapAttachment(attachment)),
        nextAfter: nextCursor(page),
      }
    }
    case "issue-labels": {
      const page = (
        await gql(client, accessToken, IssueLabelsPageDocument, {
          id: follow.queryId,
          after: follow.after,
        })
      ).issue.labels
      return {
        connection: follow.connection,
        labels: page.nodes.map((label) => ({ id: label.id, name: label.name })),
        nextAfter: nextCursor(page),
      }
    }
    case "issue-needs":
    case "project-needs": {
      const page =
        follow.connection === "issue-needs"
          ? (
              await gql(client, accessToken, IssueNeedsPageDocument, {
                id: follow.queryId,
                after: follow.after,
              })
            ).issue.needs
          : (
              await gql(client, accessToken, ProjectNeedsPageDocument, {
                id: follow.queryId,
                after: follow.after,
              })
            ).project.needs
      return {
        connection: follow.connection,
        needs: page.nodes.map((need) =>
          mapNeed(need, {
            issueId:
              follow.connection === "issue-needs" ? follow.entityId : null,
            projectId:
              follow.connection === "project-needs" ? follow.entityId : null,
          }),
        ),
        actors: presentActors(page.nodes.map((need) => need.creator)),
        nextAfter: nextCursor(page),
      }
    }
    case "issue-project-teams": {
      const page = (
        await gql(client, accessToken, IssueProjectTeamsDocument, {
          id: follow.queryId,
          after: follow.after,
        })
      ).issue.project?.teams
      return {
        connection: follow.connection,
        teamIds: page?.nodes.map((team) => team.id) ?? [],
        nextAfter: nextCursor(page),
      }
    }
    case "project-teams":
    case "document-project-teams": {
      const page = (
        await gql(client, accessToken, ProjectTeamsPageDocument, {
          id: follow.queryId,
          after: follow.after,
        })
      ).project.teams
      return {
        connection: follow.connection,
        teamIds: page.nodes.map((team) => team.id),
        nextAfter: nextCursor(page),
      }
    }
    case "project-updates": {
      const page = (
        await gql(client, accessToken, ProjectUpdatesPageDocument, {
          id: follow.queryId,
          after: follow.after,
        })
      ).project.projectUpdates
      return {
        connection: follow.connection,
        updates: page.nodes.map(mapUpdate),
        nextAfter: nextCursor(page),
      }
    }
    case "initiative-updates": {
      const page = (
        await gql(client, accessToken, InitiativeUpdatesPageDocument, {
          id: follow.queryId,
          after: follow.after,
        })
      ).initiative.initiativeUpdates
      return {
        connection: follow.connection,
        updates: page.nodes.map(mapUpdate),
        nextAfter: nextCursor(page),
      }
    }
    case "project-documents": {
      const page = (
        await gql(client, accessToken, ProjectDocumentsPageDocument, {
          id: follow.queryId,
          after: follow.after,
        })
      ).project.documents
      const documents = page.nodes.map((document) => mapDocument(document, []))
      return {
        connection: follow.connection,
        documents,
        actors: presentActors(documents.map((document) => document.creator)),
        nextAfter: nextCursor(page),
      }
    }
  }
}

export function applyLinearFollowToIssue(
  loaded: LoadedIssue,
  page: LinearFollowPage,
): LoadedIssue {
  switch (page.connection) {
    case "issue-comments":
      return {
        ...loaded,
        issue: {
          ...loaded.issue,
          comments: [...loaded.issue.comments, ...page.comments],
        },
        actors: [...loaded.actors, ...page.actors],
      }
    case "issue-attachments":
      return {
        ...loaded,
        issue: {
          ...loaded.issue,
          attachments: [...loaded.issue.attachments, ...page.attachments],
        },
      }
    case "issue-labels":
      return {
        ...loaded,
        issue: {
          ...loaded.issue,
          labels: [...loaded.issue.labels, ...page.labels],
        },
      }
    case "issue-needs":
      return {
        ...loaded,
        needs: [...loaded.needs, ...page.needs],
        actors: [...loaded.actors, ...page.actors],
      }
    case "issue-project-teams":
      return {
        ...loaded,
        projectTeamIds: [...loaded.projectTeamIds, ...page.teamIds],
      }
    default:
      return loaded
  }
}

export function applyLinearFollowToProject(
  loaded: LoadedProject,
  page: LinearFollowPage,
): LoadedProject {
  switch (page.connection) {
    case "project-teams":
      return { ...loaded, teamIds: [...loaded.teamIds, ...page.teamIds] }
    case "project-updates":
      return { ...loaded, updates: [...loaded.updates, ...page.updates] }
    case "project-documents":
      return {
        ...loaded,
        documents: [...loaded.documents, ...page.documents],
        actors: [...loaded.actors, ...page.actors],
      }
    case "project-needs":
      return {
        ...loaded,
        needs: [...loaded.needs, ...page.needs],
        actors: [...loaded.actors, ...page.actors],
      }
    default:
      return loaded
  }
}

export function applyLinearFollowToInitiative(
  loaded: LoadedInitiative,
  page: LinearFollowPage,
): LoadedInitiative {
  if (page.connection !== "initiative-updates") return loaded
  return { ...loaded, updates: [...loaded.updates, ...page.updates] }
}

export function applyLinearFollowToDocument(
  loaded: LoadedDocument,
  page: LinearFollowPage,
): LoadedDocument {
  if (page.connection !== "document-project-teams") return loaded
  return {
    ...loaded,
    projectTeamIds: [...loaded.projectTeamIds, ...page.teamIds],
  }
}
