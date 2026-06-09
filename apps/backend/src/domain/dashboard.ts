import { and, count, eq, gte, sql } from "drizzle-orm"
import { getOrgDb, getSystemDb } from "../db/client.js"
import { agentActivityEvents } from "../db/schema/agent_activity_events.js"
import { members, users } from "../db/schema/auth.js"
import { claims } from "../db/schema/claims.js"
import { confluenceSpaces } from "../db/schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { connections } from "../db/schema/connections.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import {
  forgeConnectionToShape,
  githubConnectionToShape,
} from "../models/connection-rows.js"
import { getKnowledgeGraphSnapshot } from "./knowledgeGraphSnapshot.js"

export type DashboardRange = "7d" | "30d"
export type DashboardStatus = "ok" | "warning" | "error" | "unknown"

export type DashboardActivityCounts = {
  total: number
  ui: number
  mcp: number
  graph: number
  other: number
}

export type DashboardActivityBucket = {
  date: string
  you: DashboardActivityCounts
  organisation: DashboardActivityCounts
}

export type DashboardMemberActivity = DashboardActivityCounts & {
  userId: string
  name: string | null
  email: string | null
  lastActiveAt: string | null
}

export type DashboardActivity = {
  range: DashboardRange
  buckets: DashboardActivityBucket[]
  members: DashboardMemberActivity[] | null
}

export type DashboardAction = {
  severity: "error" | "warning" | "info"
  title: string
  detail: string
  href: string
}

export type DashboardSummary = {
  health: {
    overall: DashboardStatus
    repositories: {
      status: DashboardStatus
      total: number
      indexed: number
      indexing: number
      notReady: number
    }
    graph: {
      status: DashboardStatus
      totalNodes: number | null
      totalEdges: number | null
      lastObservedAt: string | null
    }
    connectors: {
      status: DashboardStatus
      github: { total: number; installed: number; needsSetup: number }
      forge: {
        total: number
        installed: number
        running: number
        failed: number
      }
    }
    confluence: {
      status: DashboardStatus
      syncTargets: number
      enabledTargets: number
      spaces: number
      lastSyncedAt: string | null
    }
    evidence: {
      status: DashboardStatus
      activeClaims: number
      lowConfidenceClaims: number
      instructionUnits: number
      lastObservedAt: string | null
    }
  }
  actions: DashboardAction[]
  activity: DashboardActivity
}

function emptyCounts(): DashboardActivityCounts {
  return { total: 0, ui: 0, mcp: 0, graph: 0, other: 0 }
}

function addSource(counts: DashboardActivityCounts, source: string): void {
  counts.total += 1
  if (source === "ui") counts.ui += 1
  else if (source === "mcp") counts.mcp += 1
  else if (source === "knowledge-graph") counts.graph += 1
  else counts.other += 1
}

function rangeDays(range: DashboardRange): number {
  return range === "7d" ? 7 : 30
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function startDateForRange(range: DashboardRange): Date {
  const now = new Date()
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  start.setUTCDate(start.getUTCDate() - (rangeDays(range) - 1))
  return start
}

function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "string" && v.length > 0) return v
  return null
}

function num(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

function makeBuckets(range: DashboardRange): DashboardActivityBucket[] {
  const start = startDateForRange(range)
  return Array.from({ length: rangeDays(range) }, (_, i) => {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    return {
      date: dateKey(d),
      you: emptyCounts(),
      organisation: emptyCounts(),
    }
  })
}

export async function getDashboardActivity(input: {
  orgId: string
  userId: string
  range: DashboardRange
  includeMembers: boolean
}): Promise<DashboardActivity> {
  const db = getOrgDb()
  const rows = await db
    .select({
      userId: agentActivityEvents.userId,
      source: agentActivityEvents.source,
      occurredAt: agentActivityEvents.occurredAt,
    })
    .from(agentActivityEvents)
    .where(
      and(
        eq(agentActivityEvents.orgId, input.orgId),
        gte(agentActivityEvents.occurredAt, startDateForRange(input.range)),
      ),
    )

  const buckets = makeBuckets(input.range)
  const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]))
  const byMember = new Map<
    string,
    DashboardActivityCounts & { lastActiveAt: Date | null }
  >()

  for (const row of rows) {
    const key = dateKey(row.occurredAt)
    const bucket = byDate.get(key)
    if (!bucket) continue
    addSource(bucket.organisation, row.source)
    if (row.userId === input.userId) addSource(bucket.you, row.source)

    if (!input.includeMembers) continue
    const memberCounts = byMember.get(row.userId) ?? {
      ...emptyCounts(),
      lastActiveAt: null,
    }
    addSource(memberCounts, row.source)
    if (
      !memberCounts.lastActiveAt ||
      row.occurredAt > memberCounts.lastActiveAt
    ) {
      memberCounts.lastActiveAt = row.occurredAt
    }
    byMember.set(row.userId, memberCounts)
  }

  let memberActivity: DashboardMemberActivity[] | null = null
  if (input.includeMembers) {
    const systemDb = getSystemDb()
    const memberRows = await systemDb
      .select({
        userId: members.userId,
        name: users.name,
        email: users.email,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.organizationId, input.orgId))

    memberActivity = memberRows
      .map((member) => {
        const counts = byMember.get(member.userId) ?? {
          ...emptyCounts(),
          lastActiveAt: null,
        }
        return {
          userId: member.userId,
          name: member.name,
          email: member.email,
          total: counts.total,
          ui: counts.ui,
          mcp: counts.mcp,
          graph: counts.graph,
          other: counts.other,
          lastActiveAt: counts.lastActiveAt?.toISOString() ?? null,
        }
      })
      .sort((a, b) => b.total - a.total || a.email.localeCompare(b.email))
  }

  return {
    range: input.range,
    buckets,
    members: memberActivity,
  }
}

async function repositoryHealth(orgId: string) {
  const db = getOrgDb()
  const rows = await db
    .select({
      indexReady: repositories.indexReady,
      indexingReason: repositories.indexingReason,
    })
    .from(repositories)
    .where(eq(repositories.orgId, orgId))
  const indexed = rows.filter((r) => r.indexReady).length
  const indexing = rows.filter((r) => !r.indexReady && r.indexingReason).length
  const notReady = rows.length - indexed
  return {
    status:
      rows.length === 0 || notReady > 0
        ? ("warning" as const)
        : ("ok" as const),
    total: rows.length,
    indexed,
    indexing,
    notReady,
  }
}

async function connectorHealth(orgId: string) {
  const systemDb = getSystemDb()
  const rows = await systemDb
    .select()
    .from(connections)
    .where(eq(connections.orgId, orgId))

  const github = { total: 0, installed: 0, needsSetup: 0 }
  const forge = { total: 0, installed: 0, running: 0, failed: 0 }
  let parseFailures = 0

  for (const row of rows) {
    try {
      if (row.type === "github") {
        github.total += 1
        const shape = githubConnectionToShape(row)
        if (shape.installationId) github.installed += 1
        else github.needsSetup += 1
      } else if (row.type === "forge") {
        forge.total += 1
        const shape = forgeConnectionToShape(row)
        if (shape.status === "installed") forge.installed += 1
        if (shape.provisionStatus === "running") forge.running += 1
        if (shape.provisionStatus === "failed") forge.failed += 1
      }
    } catch {
      parseFailures += 1
    }
  }

  const status =
    parseFailures > 0 || forge.failed > 0
      ? "error"
      : github.needsSetup > 0 || forge.running > 0
        ? "warning"
        : "ok"
  return { status: status as DashboardStatus, github, forge }
}

async function confluenceHealth(orgId: string) {
  const systemDb = getSystemDb()
  const [targetCounts] = await systemDb
    .select({
      total: count(),
      enabled: sql<number>`count(*) filter (where ${confluenceSyncTargets.enabled} = true)`,
      awaiting: sql<number>`count(*) filter (where ${confluenceSyncTargets.setupPhase} <> 'live')`,
    })
    .from(confluenceSyncTargets)
    .where(eq(confluenceSyncTargets.orgId, orgId))

  const [spaceCounts] = await systemDb
    .select({
      total: count(),
      lastSyncedAt: sql<Date | null>`max(${confluenceSpaces.lastSyncedAt})`,
    })
    .from(confluenceSpaces)
    .innerJoin(connections, eq(connections.id, confluenceSpaces.connectionId))
    .where(eq(connections.orgId, orgId))

  const syncTargets = num(targetCounts?.total)
  const awaiting = num(targetCounts?.awaiting)
  return {
    status: awaiting > 0 ? ("warning" as const) : ("ok" as const),
    syncTargets,
    enabledTargets: num(targetCounts?.enabled),
    spaces: num(spaceCounts?.total),
    lastSyncedAt: iso(spaceCounts?.lastSyncedAt),
  }
}

async function evidenceHealth(orgId: string) {
  const db = getOrgDb()
  const [claimRow] = await db
    .select({
      activeClaims: sql<number>`count(*) filter (where ${claims.status} = 'active')`,
      lowConfidenceClaims: sql<number>`count(*) filter (where ${claims.status} = 'active' and ${claims.aggregatedConfidence} < 0.7)`,
      lastObservedAt: sql<Date | null>`max(${claims.lastObservedAt})`,
    })
    .from(claims)
    .where(eq(claims.orgId, orgId))

  const [instructionRow] = await db
    .select({ total: count() })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.kind, "InstructionUnit")))

  const activeClaims = num(claimRow?.activeClaims)
  const lowConfidenceClaims = num(claimRow?.lowConfidenceClaims)
  return {
    status:
      activeClaims === 0 || lowConfidenceClaims > 0
        ? ("warning" as const)
        : ("ok" as const),
    activeClaims,
    lowConfidenceClaims,
    instructionUnits: num(instructionRow?.total),
    lastObservedAt: iso(claimRow?.lastObservedAt),
  }
}

async function graphHealth(orgId: string, orgSlug: string) {
  try {
    const snapshot = await getKnowledgeGraphSnapshot(orgId, orgSlug, {
      nodeLimit: 1,
      edgeLimit: 1,
    })
    return {
      status:
        snapshot.metrics.totalNodes === 0
          ? ("warning" as const)
          : ("ok" as const),
      totalNodes: snapshot.metrics.totalNodes,
      totalEdges: snapshot.metrics.totalEdges,
      lastObservedAt: snapshot.metrics.lastUpdatedAt,
    }
  } catch {
    return {
      status: "unknown" as const,
      totalNodes: null,
      totalEdges: null,
      lastObservedAt: null,
    }
  }
}

function overallStatus(statuses: DashboardStatus[]): DashboardStatus {
  if (statuses.includes("error")) return "error"
  if (statuses.includes("unknown")) return "unknown"
  if (statuses.includes("warning")) return "warning"
  return "ok"
}

function buildActions(input: DashboardSummary["health"], orgSlug: string) {
  const actions: DashboardAction[] = []
  if (input.repositories.total === 0) {
    actions.push({
      severity: "warning",
      title: "No repositories are connected",
      detail: "Add a repository so ctxpipe can build search and graph context.",
      href: `/${orgSlug}/repositories`,
    })
  } else if (input.repositories.notReady > 0) {
    actions.push({
      severity: "warning",
      title: `${input.repositories.notReady} repositories are not ready`,
      detail: "Index or re-index repositories before relying on agent context.",
      href: `/${orgSlug}/repositories`,
    })
  }
  if (input.connectors.github.needsSetup > 0) {
    actions.push({
      severity: "warning",
      title: "GitHub connector setup is incomplete",
      detail: "Finish installation so repository changes keep context fresh.",
      href: `/${orgSlug}/repositories/github/setup`,
    })
  }
  if (input.connectors.forge.failed > 0) {
    actions.push({
      severity: "error",
      title: "Confluence provisioning failed",
      detail: "Review the Forge connector status and retry provisioning.",
      href: `/${orgSlug}/connectors`,
    })
  }
  if (input.graph.status === "unknown") {
    actions.push({
      severity: "error",
      title: "Knowledge graph is unavailable",
      detail:
        "Graph health could not be checked; agents may miss relationships.",
      href: `/${orgSlug}/knowledge-graph`,
    })
  } else if (input.graph.totalNodes === 0 && input.evidence.activeClaims > 0) {
    actions.push({
      severity: "warning",
      title: "Knowledge facts are not in the graph",
      detail:
        "Rebuild the graph so agent answers can use the extracted context.",
      href: `/${orgSlug}/knowledge-graph`,
    })
  }
  if (input.evidence.lowConfidenceClaims > 0) {
    actions.push({
      severity: "info",
      title: `${input.evidence.lowConfidenceClaims} evidence items need review`,
      detail:
        "Review low-confidence context before depending on it in agent answers.",
      href: `/${orgSlug}/knowledge-graph`,
    })
  }
  return actions
}

export async function getDashboardSummary(input: {
  orgId: string
  orgSlug: string
  userId: string
  range: DashboardRange
  includeMembers: boolean
}): Promise<DashboardSummary> {
  const [
    repositoriesHealth,
    connectors,
    confluence,
    evidence,
    graph,
    activity,
  ] = await Promise.all([
    repositoryHealth(input.orgId),
    connectorHealth(input.orgId),
    confluenceHealth(input.orgId),
    evidenceHealth(input.orgId),
    graphHealth(input.orgId, input.orgSlug),
    getDashboardActivity(input),
  ])

  const health: DashboardSummary["health"] = {
    overall: overallStatus([
      repositoriesHealth.status,
      connectors.status,
      confluence.status,
      evidence.status,
      graph.status,
    ]),
    repositories: repositoriesHealth,
    graph,
    connectors,
    confluence,
    evidence,
  }

  return {
    health,
    actions: buildActions(health, input.orgSlug),
    activity,
  }
}
