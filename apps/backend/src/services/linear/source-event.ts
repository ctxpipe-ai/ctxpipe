import { z } from "zod"

import {
  type LinearSourceScope,
  linearProjects,
  linearTeams,
} from "../../domain/workspace-sources/providers/linear.js"

const knownOrAny = z.union([z.literal("any"), z.array(z.string())])

/**
 * The part of a Linear webhook that routes it to sources: the team keys and
 * project ids of the changed entity, or "any" when the payload does not tell
 * them. `entity` is the change that the incremental mirror applies.
 */
const linearEntitySchema = z.object({
  entityType: z.enum([
    "cycle",
    "customerNeed",
    "document",
    "initiative",
    "issue",
    "issueLabel",
    "project",
    "team",
    "user",
  ]),
  externalId: z.string().min(1),
  action: z.enum(["upsert", "delete"]),
})

export const linearSourceEventSchema = z.object({
  teamKeys: knownOrAny,
  projectIds: knownOrAny,
  entity: linearEntitySchema.optional(),
  /** The changes of coalesced webhooks (CTX-1595), in the order they came. */
  entities: z.array(linearEntitySchema).optional(),
})
type LinearSourceEvent = z.infer<typeof linearSourceEventSchema>

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** `ENG-123` gives `ENG`. */
function keyOfIdentifier(identifier: unknown): string | undefined {
  const value = text(identifier)
  const dash = value?.lastIndexOf("-") ?? -1
  return value && dash > 0 ? value.slice(0, dash) : undefined
}

function present(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item)))]
}

/** Events whose entity sits in one team, and in at most the project it names. */
const TEAM_EVENTS = new Set([
  "Issue",
  "Comment",
  "Attachment",
  "Cycle",
  "IssueLabel",
  "Team",
])

/**
 * Read the team keys and project ids from a verified Linear webhook payload.
 * A team change of an issue (`updatedFrom.teamId`) gives "any" team, so that
 * the old team's copy updates too. A project event gives "any" team, because
 * each team source that holds the project has a copy.
 */
export function linearSourceEventFromPayload(
  payload: Record<string, unknown>,
  entity?: LinearSourceEvent["entity"],
): LinearSourceEvent {
  const type = text(payload.type) ?? ""
  const data = record(payload.data)
  const issue = record(data.issue)
  const updatedFrom = record(payload.updatedFrom)
  const keys = present(
    [
      type === "Team" ? text(data.key) : undefined,
      text(record(data.team).key),
      keyOfIdentifier(data.identifier),
      text(record(issue.team).key),
      keyOfIdentifier(issue.identifier),
    ].map((key) => key?.toUpperCase()),
  )
  const projectFields = [data, issue, updatedFrom].some(
    (fields) => "projectId" in fields,
  )
  const projects = present([
    type === "Project" ? text(data.id) : undefined,
    text(data.projectId),
    text(record(data.project).id),
    text(issue.projectId),
    text(updatedFrom.projectId),
  ])
  const teamKnown =
    TEAM_EVENTS.has(type) && keys.length > 0 && !("teamId" in updatedFrom)
  const projectKnown =
    type === "Project" ||
    type === "ProjectUpdate" ||
    projectFields ||
    ["Team", "Cycle", "IssueLabel"].includes(type)
  return {
    teamKeys: teamKnown ? keys : "any",
    projectIds: projectKnown ? projects : "any",
    ...(entity ? { entity } : {}),
  }
}

/** Whether a webhook event can touch the content of a Linear source. */
export function linearEventMatches(
  event: unknown,
  scope: LinearSourceScope,
): boolean {
  const parsed = linearSourceEventSchema.safeParse(event)
  if (!parsed.success) return true
  const { teamKeys, projectIds } = parsed.data
  const teams = linearTeams(scope)
  const projects = linearProjects(scope)
  return (
    (teams.length > 0 &&
      (teamKeys === "any" ||
        teams.some((key) => teamKeys.includes(key.toUpperCase())))) ||
    (projects.length > 0 &&
      (projectIds === "any" || projects.some((id) => projectIds.includes(id))))
  )
}

/** The changed entities of an event: one, or the list of a joined event. */
export function linearEventEntities(
  event: LinearSourceEvent | undefined,
): NonNullable<LinearSourceEvent["entities"]> {
  return event?.entities ?? (event?.entity ? [event.entity] : [])
}

function joinKnown(lists: ReadonlyArray<"any" | string[]>): "any" | string[] {
  return lists.some((list) => list === "any")
    ? "any"
    : [...new Set(lists.flatMap((list) => (list === "any" ? [] : list)))]
}

/**
 * Join the events of coalesced webhooks into one event (CTX-1595). The event
 * touches each source that one of the events touches. Each entity occurs one
 * time, with the action of its last event: the incremental mirror reads the
 * entity as it is now. An event that cannot be read, or that has no entity,
 * gives `undefined`: a full sync of the connection, as one such event gives.
 */
export function mergeLinearSourceEvents(
  events: readonly unknown[],
): LinearSourceEvent | undefined {
  const parsed: LinearSourceEvent[] = []
  for (const event of events) {
    const result = linearSourceEventSchema.safeParse(event)
    if (!result.success) return undefined
    parsed.push(result.data)
  }
  const entities = new Map<string, NonNullable<LinearSourceEvent["entity"]>>()
  for (const event of parsed) {
    const changes = linearEventEntities(event)
    if (!changes.length) return undefined
    for (const entity of changes) {
      const key = `${entity.entityType}:${entity.externalId}`
      // A later change of the same entity goes to the end of the order.
      entities.delete(key)
      entities.set(key, entity)
    }
  }
  if (!entities.size) return undefined
  return {
    teamKeys: joinKnown(parsed.map((event) => event.teamKeys)),
    projectIds: joinKnown(parsed.map((event) => event.projectIds)),
    entities: [...entities.values()],
  }
}
