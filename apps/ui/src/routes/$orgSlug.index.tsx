import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconChartBar,
  IconCheck,
  IconDatabase,
  IconGitBranch,
  IconPlug,
  IconRefresh,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { AppShell } from "@/components/AppShell"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

export const Route = createFileRoute("/$orgSlug/")({
  component: OrgHomePage,
})

type DashboardStatus = "ok" | "warning" | "error" | "unknown"
type ActivityMode = "organisation" | "you"

type ActivityCounts = {
  total: number
  ui: number
  mcp: number
  graph: number
  other: number
}

type DashboardSummary = {
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
  actions: Array<{
    severity: "error" | "warning" | "info"
    title: string
    detail: string
    href: string
  }>
  activity: {
    range: "7d" | "30d"
    buckets: Array<{
      date: string
      you: ActivityCounts
      organisation: ActivityCounts
    }>
    members: Array<
      ActivityCounts & {
        userId: string
        name: string | null
        email: string | null
        lastActiveAt: string | null
      }
    > | null
  }
}

type DashboardMember = NonNullable<
  DashboardSummary["activity"]["members"]
>[number]

function OrgHomePage() {
  const { orgSlug } = Route.useParams()
  return <Navigate to="/$orgSlug/dashboard" params={{ orgSlug }} replace />
}

function statusText(status: DashboardStatus): string {
  if (status === "ok") return "Ready"
  if (status === "warning") return "Needs attention"
  if (status === "error") return "Blocked"
  return "Unknown"
}

function statusClass(status: DashboardStatus): string {
  if (status === "ok") return "text-teal-300"
  if (status === "warning") return "text-amber-300"
  if (status === "error") return "text-red-300"
  return "text-zinc-400"
}

function actionClass(severity: "error" | "warning" | "info"): string {
  if (severity === "error") return "border-red-900/70 bg-red-950/20"
  if (severity === "warning") return "border-amber-900/70 bg-amber-950/20"
  return "border-zinc-800/95 bg-zinc-950"
}

function formatNumber(value: number | null): string {
  return value == null ? "Unknown" : value.toLocaleString()
}

function memberLabel(member: DashboardMember): string {
  return member.name ?? member.email ?? "Unknown member"
}

function timeValue(iso: string | null): number {
  if (!iso) return 0
  const value = new Date(iso).getTime()
  return Number.isFinite(value) ? value : 0
}

function pluralise(count: number, singular: string, plural = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Unknown"
  const deltaMs = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "Just now"
  const mins = Math.floor(deltaMs / 60_000)
  if (mins < 1) return "Just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Exported for Storybook — dashboard content for `/$orgSlug/dashboard`. */
export function OrgHomePageContent({ orgSlug }: { orgSlug: string }) {
  const [preferences, updatePreferences] = useUserPreferences()
  const { data: session, isPending: sessionPending } = useSession()
  const [activityMode, setActivityMode] = useState<ActivityMode>("organisation")

  const {
    data: summary,
    isFetching,
    isPending,
    error,
    refetch,
  } = useQuery({
    queryKey: ["dashboard-summary", orgSlug],
    enabled: !!session,
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.dashboard.summary.$get({
        param: { orgSlug },
        query: { range: "30d" },
      })
      if (!res.ok) {
        throw new Error(`Dashboard summary failed: ${res.status}`)
      }
      return (await res.json()) as DashboardSummary
    },
  })

  useEffect(() => {
    if (preferences.selectedOrganizationSlug !== orgSlug) {
      updatePreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: orgSlug,
      }))
    }
  }, [orgSlug, preferences.selectedOrganizationSlug, updatePreferences])

  if (sessionPending) {
    return (
      <AppShell>
        <main className="mx-auto box-border flex min-h-screen w-full max-w-2xl items-center justify-center p-8 text-zinc-100">
          <InlineLoader label="Loading workspace" />
        </main>
      </AppShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const buckets = summary?.activity.buckets ?? []
  const bucketMax = Math.max(
    1,
    ...buckets.map((bucket) => bucket[activityMode].total),
  )
  const activityTotal = buckets.reduce(
    (sum, bucket) => sum + bucket[activityMode].total,
    0,
  )
  const sourceTotals = {
    mcp: buckets.reduce((sum, bucket) => sum + bucket[activityMode].mcp, 0),
    ui: buckets.reduce((sum, bucket) => sum + bucket[activityMode].ui, 0),
    graph: buckets.reduce((sum, bucket) => sum + bucket[activityMode].graph, 0),
    other: buckets.reduce((sum, bucket) => sum + bucket[activityMode].other, 0),
  }
  const members = summary?.activity.members ?? null
  const rankedMembers = members
    ? [...members].sort(
        (a, b) =>
          b.total - a.total ||
          timeValue(b.lastActiveAt) - timeValue(a.lastActiveAt) ||
          memberLabel(a).localeCompare(memberLabel(b)),
      )
    : null
  const activeMemberCount =
    members?.filter((member) => member.total > 0).length ?? 0
  const memberCount = members?.length ?? 0
  const connectorTotal = summary
    ? summary.health.connectors.github.total +
      summary.health.connectors.forge.total
    : 0
  const repositoryLabel =
    summary && summary.health.repositories.total > 0
      ? `${summary.health.repositories.indexed}/${summary.health.repositories.total}`
      : "None"
  const repositoryDetail =
    summary && summary.health.repositories.total > 0
      ? pluralise(
          summary.health.repositories.notReady,
          "not ready",
          "not ready",
        )
      : "Connect a repository"
  const connectorLabel =
    connectorTotal > 0 ? connectorTotal.toLocaleString() : "None"
  const connectorDetail =
    connectorTotal > 0
      ? pluralise(
          summary?.health.connectors.forge.failed ?? 0,
          "failed",
          "failed",
        )
      : "No connectors"
  const readinessRows = summary
    ? [
        [
          "Graph last observed",
          timeAgo(
            summary.health.graph.lastObservedAt ??
              summary.health.evidence.lastObservedAt,
          ),
        ],
        [
          "Agent instructions",
          summary.health.evidence.instructionUnits.toLocaleString(),
        ],
        [
          "Knowledge facts",
          summary.health.evidence.activeClaims.toLocaleString(),
        ],
        ...(summary.health.evidence.lowConfidenceClaims > 0
          ? [
              [
                "Evidence needing review",
                summary.health.evidence.lowConfidenceClaims.toLocaleString(),
              ],
            ]
          : []),
        ...(summary.health.confluence.syncTargets > 0 ||
        summary.health.confluence.spaces > 0 ||
        summary.health.confluence.lastSyncedAt
          ? [
              [
                "Confluence spaces",
                summary.health.confluence.spaces.toLocaleString(),
              ],
              [
                "Confluence last sync",
                timeAgo(summary.health.confluence.lastSyncedAt),
              ],
            ]
          : []),
      ]
    : []

  return (
    <AppShell>
      <div className="flex min-h-full min-w-0 flex-1 flex-col text-foreground">
        <div className="mx-auto box-border flex w-full max-w-6xl flex-1 flex-col p-8">
          <header className="mb-8 flex items-end justify-between gap-4">
            <div>
              <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                Dashboard
              </span>
              <h1 className="mt-3 text-3xl font-medium tracking-tight text-foreground">
                Context overview
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Health, freshness, and context activity for this organisation.
              </p>
            </div>
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              {orgSlug}
            </span>
          </header>

          {error ? (
            <section className="mb-6 border border-red-900/70 bg-red-950/20 p-4">
              <div className="flex items-center gap-2 text-sm text-red-200">
                <IconAlertTriangle className="size-4" aria-hidden />
                Dashboard data is unavailable.
              </div>
              <p className="mt-2 text-sm text-red-100/70">
                The readiness summary could not be loaded, so zero values are
                not being inferred.
              </p>
            </section>
          ) : null}

          {isPending ? (
            <section className="flex min-h-[20rem] items-center justify-center border border-zinc-800/95 bg-zinc-950/85 p-6">
              <InlineLoader
                label="Loading context health"
                sublabel="Preparing readiness and activity"
              />
            </section>
          ) : null}

          {summary ? (
            <>
              <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <article className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                      Overall
                    </p>
                    <IconActivity
                      className="size-4 text-zinc-500"
                      aria-hidden
                    />
                  </div>
                  <p
                    className={`mt-3 text-2xl font-medium ${statusClass(summary.health.overall)}`}
                  >
                    {statusText(summary.health.overall)}
                  </p>
                  <p className="mt-2 text-sm text-zinc-400">
                    {summary.actions.length} open actions
                  </p>
                </article>

                <article className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                      Repositories
                    </p>
                    <IconGitBranch
                      className="size-4 text-zinc-500"
                      aria-hidden
                    />
                  </div>
                  <p className="mt-3 text-2xl font-medium text-zinc-100">
                    {repositoryLabel}
                  </p>
                  <p
                    className={`mt-2 text-sm ${statusClass(summary.health.repositories.status)}`}
                  >
                    {repositoryDetail}
                  </p>
                </article>

                <article className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                      Knowledge graph
                    </p>
                    <IconDatabase
                      className="size-4 text-zinc-500"
                      aria-hidden
                    />
                  </div>
                  <p className="mt-3 text-2xl font-medium text-zinc-100">
                    {formatNumber(summary.health.graph.totalNodes)}
                  </p>
                  <p
                    className={`mt-2 text-sm ${statusClass(summary.health.graph.status)}`}
                  >
                    {formatNumber(summary.health.graph.totalEdges)} edges
                  </p>
                </article>

                <article className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                      Connectors
                    </p>
                    <IconPlug className="size-4 text-zinc-500" aria-hidden />
                  </div>
                  <p className="mt-3 text-2xl font-medium text-zinc-100">
                    {connectorLabel}
                  </p>
                  <p
                    className={`mt-2 text-sm ${statusClass(summary.health.connectors.status)}`}
                  >
                    {connectorDetail}
                  </p>
                </article>
              </section>

              <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
                <section className="border border-zinc-800/95 bg-zinc-950/85 p-4 xl:col-span-2">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                      Action queue
                    </h2>
                    <span className="text-xs text-zinc-500">
                      {isFetching ? "Refreshing" : "Current"}
                    </span>
                  </div>
                  <div className="mt-4 space-y-2">
                    {summary.actions.map((action) => (
                      <a
                        key={`${action.title}:${action.href}`}
                        href={action.href}
                        className={`flex items-center justify-between gap-4 border px-3 py-3 transition-colors hover:border-zinc-700 ${actionClass(action.severity)}`}
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-zinc-100">
                            {action.title}
                          </span>
                          <span className="mt-1 block text-sm text-zinc-400">
                            {action.detail}
                          </span>
                        </span>
                        <IconArrowRight className="size-4 shrink-0 text-zinc-500" />
                      </a>
                    ))}
                    {summary.actions.length === 0 ? (
                      <div className="flex items-center gap-2 border border-zinc-900/95 bg-zinc-950 px-3 py-4 text-sm text-teal-300">
                        <IconCheck className="size-4" aria-hidden />
                        No readiness actions open.
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                      Context activity
                    </h2>
                    <div className="flex border border-zinc-800 text-xs">
                      {(["organisation", "you"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setActivityMode(mode)}
                          className={`px-2 py-1 capitalize ${
                            activityMode === mode
                              ? "bg-teal-400 text-zinc-950"
                              : "text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="mt-3 text-2xl font-medium text-zinc-100">
                    {activityTotal.toLocaleString()}
                  </p>
                  <p className="mt-1 text-sm text-zinc-500">
                    activity events in 30 days
                  </p>
                  <div className="mt-4 flex h-24 items-end gap-1 border border-zinc-900/95 bg-zinc-950/70 p-2">
                    {activityTotal === 0 ? (
                      <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                        No activity captured yet
                      </div>
                    ) : (
                      buckets.map((bucket) => (
                        <div
                          key={bucket.date}
                          className="flex min-w-0 flex-1 items-end bg-zinc-900/70"
                          title={`${bucket.date}: ${bucket[activityMode].total}`}
                        >
                          <div
                            className="w-full bg-teal-400"
                            style={{
                              height: `${Math.max(4, (bucket[activityMode].total / bucketMax) * 100)}%`,
                            }}
                          />
                        </div>
                      ))
                    )}
                  </div>
                  <div className="mt-4 grid grid-cols-4 gap-2 text-xs">
                    {[
                      ["MCP", sourceTotals.mcp],
                      ["Chat", sourceTotals.ui],
                      ["Graph", sourceTotals.graph],
                      ["Other", sourceTotals.other],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="border border-zinc-900/95 bg-zinc-950 p-2"
                      >
                        <span className="block text-zinc-500">{label}</span>
                        <span className="mt-1 block text-zinc-100">
                          {value}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4">
                <section className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                      Readiness detail
                    </h2>
                    <IconChartBar
                      className="size-4 text-zinc-500"
                      aria-hidden
                    />
                  </div>
                  <div className="mt-4 space-y-3 text-sm">
                    {readinessRows.map(([label, value]) => (
                      <div
                        key={label}
                        className="flex items-center justify-between border border-zinc-900/95 bg-zinc-950 px-3 py-2"
                      >
                        <span className="text-zinc-400">{label}</span>
                        <span className="text-zinc-100">{value}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                        Member activity
                      </h2>
                      {members ? (
                        <p className="mt-2 text-sm text-zinc-500">
                          {pluralise(activeMemberCount, "active member")} of{" "}
                          {memberCount.toLocaleString()} · ranked by 30-day
                          activity
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => void refetch()}
                      disabled={isFetching}
                      className="inline-flex size-8 items-center justify-center border border-zinc-800 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-teal-400"
                      aria-label="Refresh member activity"
                      title="Refresh member activity"
                    >
                      {isFetching ? (
                        <IconRefresh
                          className="size-4 animate-spin"
                          aria-hidden
                        />
                      ) : (
                        <IconRefresh className="size-4" aria-hidden />
                      )}
                    </button>
                  </div>
                  <div className="mt-4">
                    {rankedMembers ? (
                      <div className="overflow-x-auto border border-zinc-900/95">
                        <div className="max-h-[31.5rem] min-w-[760px] overflow-y-auto">
                          <div className="sticky top-0 grid grid-cols-[3rem_minmax(0,1fr)_5rem_5rem_5rem_5rem_6rem] gap-3 border-b border-zinc-900/95 bg-zinc-950 px-3 py-2 text-xs uppercase tracking-[0.12em] text-zinc-500">
                            <span>Rank</span>
                            <span>Member</span>
                            <span className="text-right">Events</span>
                            <span className="text-right">MCP</span>
                            <span className="text-right">Chat</span>
                            <span className="text-right">Graph</span>
                            <span className="text-right">Last active</span>
                          </div>
                          {rankedMembers.map((member, index) => (
                            <div
                              key={member.userId}
                              className="grid grid-cols-[3rem_minmax(0,1fr)_5rem_5rem_5rem_5rem_6rem] gap-3 border-b border-zinc-900/80 px-3 py-2 last:border-b-0"
                            >
                              <span className="text-sm text-zinc-500">
                                {index + 1}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-sm text-zinc-200">
                                  {memberLabel(member)}
                                </span>
                                {member.name && member.email ? (
                                  <span className="block truncate text-xs text-zinc-500">
                                    {member.email}
                                  </span>
                                ) : null}
                              </span>
                              <span className="text-right text-sm text-zinc-100">
                                {member.total.toLocaleString()}
                              </span>
                              <span className="text-right text-sm text-zinc-500">
                                {member.mcp.toLocaleString()}
                              </span>
                              <span className="text-right text-sm text-zinc-500">
                                {member.ui.toLocaleString()}
                              </span>
                              <span className="text-right text-sm text-zinc-500">
                                {member.graph.toLocaleString()}
                              </span>
                              <span className="text-right text-sm text-zinc-500">
                                {timeAgo(member.lastActiveAt)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {members === null ? (
                      <div className="border border-zinc-900/95 bg-zinc-950 px-3 py-4 text-sm text-zinc-500">
                        Member breakdown is available to organisation admins.
                      </div>
                    ) : null}
                    {members?.length === 0 ? (
                      <div className="border border-zinc-900/95 bg-zinc-950 px-3 py-4 text-sm text-zinc-500">
                        No member activity in this range.
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </AppShell>
  )
}
