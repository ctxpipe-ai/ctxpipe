import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconRefresh,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import type { InferResponseType } from "hono/client"
import { useEffect, useState } from "react"
import { AppShell } from "@/components/AppShell"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

export const Route = createFileRoute("/$orgSlug/")({
  component: OrgHomePage,
})

type DashboardSummary = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["dashboard"]["summary"]["$get"],
  200
>
type DashboardStatus = DashboardSummary["health"]["overall"]
type ActivityMode = "organisation" | "you"
type ActivityRange = "today" | "7d" | "30d"

type DashboardMember = NonNullable<
  DashboardSummary["activity"]["members"]
>[number]
type SourceCoverageRow = {
  label: string
  coverage: number
  detail: string
  status: DashboardStatus
}

function OrgHomePage() {
  const { orgSlug } = Route.useParams()
  return <Navigate to="/$orgSlug/dashboard" params={{ orgSlug }} replace />
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

function formatScore(value: number | null): string {
  return value == null ? "No score" : value.toFixed(2)
}

function formatOptionalNumber(value: number | null): string {
  return value == null ? "Unknown" : value.toLocaleString()
}

function formatOptionalDecimal(value: number | null): string {
  if (value == null) return "Unknown"
  if (value >= 100) return Math.round(value).toLocaleString()
  return value.toFixed(1)
}

function scoreDelta(series: Array<{ value: number | null }>): {
  label: string
  className: string
} {
  const values = series
    .map((point) => point.value)
    .filter((value): value is number => value != null)
  if (values.length < 2) {
    return { label: "+0.00", className: "text-zinc-500" }
  }
  const delta = values[values.length - 1] - values[0]
  const label =
    Math.abs(delta) < 0.005
      ? "+0.00"
      : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`
  const className =
    delta < -0.005
      ? "text-rose-300"
      : delta > 0.005
        ? "text-teal-300"
        : "text-zinc-500"
  return { label, className }
}

function percentDelta(
  current: number,
  previous: number,
): {
  label: string
  className: string
} {
  if (previous <= 0) {
    return current > 0
      ? { label: "+100%", className: "text-teal-300" }
      : { label: "+0%", className: "text-zinc-500" }
  }
  const delta = ((current - previous) / previous) * 100
  const label =
    Math.abs(delta) < 0.5
      ? "+0%"
      : `${delta > 0 ? "+" : ""}${Math.round(delta)}%`
  const className =
    delta < -0.5
      ? "text-rose-300"
      : delta > 0.5
        ? "text-teal-300"
        : "text-zinc-500"
  return { label, className }
}

function pointDelta(series: Array<{ value: number | null }>): {
  label: string
  className: string
} {
  const values = series
    .map((point) => point.value)
    .filter((value): value is number => value != null)
  if (values.length < 2) {
    return { label: "+0%", className: "text-zinc-500" }
  }
  const delta = (values[values.length - 1] - values[0]) * 100
  const label =
    Math.abs(delta) < 0.5
      ? "+0%"
      : `${delta > 0 ? "+" : ""}${Math.round(delta)}%`
  const className =
    delta < -0.5
      ? "text-rose-300"
      : delta > 0.5
        ? "text-teal-300"
        : "text-zinc-500"
  return { label, className }
}

function percent(value: number, total: number): string {
  if (total <= 0) return "0%"
  return `${Math.round((value / total) * 100)}%`
}

function coveragePercent(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)))
}

function coverageBarClass(status: DashboardStatus): string {
  if (status === "error") return "bg-rose-400"
  if (status === "warning") return "bg-amber-400"
  return "bg-teal-400"
}

function percentLabel(value: number, total: number): string {
  if (total <= 0 || value <= 0) return "0%"
  const pct = (value / total) * 100
  if (pct < 1) return "<1%"
  return `${Math.round(pct)}%`
}

function buildFreshnessInsight(input: {
  total: number
  freshWithin7d: number
  stale: number
  lowConfidenceClaims: number
  notReadyRepositories: number
  docsConnected: boolean
}): string {
  if (input.total === 0) {
    return "No context claims have been extracted yet. Connect or re-index a repository to build grounding context."
  }

  const fresh = percentLabel(input.freshWithin7d, input.total)
  const stale = percentLabel(input.stale, input.total)
  const staleLead = `${stale} of active context claims are >30d old.`

  if (input.stale === 0 && input.lowConfidenceClaims === 0) {
    return `${fresh} of active context claims were observed in the last 7 days. Context is fresh and confidence looks healthy.`
  }

  if (input.stale > 0 && input.lowConfidenceClaims > 0) {
    return `${staleLead} Stale context may weaken grounding; refresh older sources to improve confidence.`
  }

  if (input.stale > 0 && input.notReadyRepositories > 0) {
    return `${staleLead} Re-index ${pluralise(input.notReadyRepositories, "not-ready repository", "not-ready repositories")} first.`
  }

  if (input.stale > 0 && input.docsConnected) {
    return `${staleLead} Stale context may weaken grounding; check connected docs sync before relying on older answers.`
  }

  if (input.stale > 0) {
    return `${staleLead} Stale context may weaken grounding; refresh the oldest indexed sources first.`
  }

  if (input.lowConfidenceClaims > 0) {
    return `${fresh} of active context claims were observed in the last 7 days. Freshness looks healthy; confidence is the next signal to improve.`
  }

  return `${fresh} of active context claims were observed in the last 7 days.`
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

function dailyUpdatedLabel(iso: string | null): string {
  return iso ? `Updated daily ${timeAgo(iso)}` : "Preparing daily metrics"
}

function Sparkline({ values }: { values: number[] }) {
  const width = 180
  const height = 42
  const baselineY = height * 0.55
  const movementHeight = height * 0.34
  if (values.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-4 h-10 w-full overflow-visible"
        aria-hidden="true"
      >
        <polyline
          points={`0,${baselineY.toFixed(1)} ${width},${baselineY.toFixed(1)}`}
          fill="none"
          stroke="#2dd4bf"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min
  const points =
    values.length > 1
      ? values
          .map((value, index) => {
            const x = (index / (values.length - 1)) * width
            const normalized = range > 0 ? (value - min) / range : 0.5
            const y =
              range > 0 ? baselineY - normalized * movementHeight : baselineY
            return `${x.toFixed(1)},${y.toFixed(1)}`
          })
          .join(" ")
      : (() => {
          return `0,${baselineY.toFixed(1)} ${width},${baselineY.toFixed(1)}`
        })()

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="mt-4 h-10 w-full overflow-visible"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="#2dd4bf"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function KpiCard({
  label,
  value,
  detail,
  detailClassName = "text-teal-300",
  series,
}: {
  label: string
  value: string
  detail: string
  detailClassName?: string
  series?: number[]
}) {
  return (
    <article className="border border-zinc-800/95 bg-zinc-950/85 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          {label}
        </p>
        <span className={`font-mono text-[11px] ${detailClassName}`}>
          {detail}
        </span>
      </div>
      <p className="mt-3 text-2xl font-medium tracking-tight text-zinc-100">
        {value}
      </p>
      {series ? <Sparkline values={series} /> : <div className="mt-4 h-10" />}
    </article>
  )
}

function GraphTopologyBand({
  graph,
}: {
  graph: DashboardSummary["health"]["graph"]
}) {
  const items = [
    ["Entities", formatOptionalNumber(graph.totalNodes), "text-zinc-100"],
    ["Relationships", formatOptionalNumber(graph.totalEdges), "text-zinc-100"],
    ["Entity types", formatOptionalNumber(graph.entityTypes), "text-teal-300"],
    [
      "Relationship types",
      formatOptionalNumber(graph.relationshipTypes),
      "text-teal-300",
    ],
    [
      "Isolated nodes",
      formatOptionalNumber(graph.isolatedNodes),
      graph.isolatedNodes && graph.isolatedNodes > 0
        ? "text-amber-300"
        : "text-zinc-100",
    ],
    ["Avg degree", formatOptionalDecimal(graph.averageDegree), "text-zinc-100"],
  ]

  return (
    <section className="mt-4 border border-zinc-800/95 bg-zinc-950/85 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
          Graph topology
        </h2>
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-600">
          {dailyUpdatedLabel(graph.computedAt)}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {items.map(([label, value, className]) => (
          <div key={label} className="min-w-0">
            <p className={`text-lg font-medium tracking-tight ${className}`}>
              {value}
            </p>
            <p className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
              {label}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

function StatusStrip({
  label,
  value,
  detail,
  status,
  href,
}: {
  label: string
  value: string
  detail: string
  status: DashboardStatus
  href?: string
}) {
  const detailClass = href
    ? "text-amber-300 hover:text-amber-100"
    : statusClass(status)
  const detailContent = (
    <>
      {detail}
      {href ? <IconArrowRight className="size-3.5" aria-hidden /> : null}
    </>
  )

  return (
    <div className="flex items-center justify-between gap-4 border border-zinc-800/95 bg-zinc-950/80 px-4 py-3">
      <div className="min-w-0">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          {label}
        </span>
        <span className="ml-3 text-sm font-medium text-zinc-100">{value}</span>
      </div>
      {href ? (
        <a
          href={href}
          className={`flex shrink-0 items-center gap-1 text-sm ${detailClass}`}
        >
          {detailContent}
        </a>
      ) : (
        <span
          className={`flex shrink-0 items-center gap-1 text-sm ${detailClass}`}
        >
          {detailContent}
        </span>
      )}
    </div>
  )
}

/** Exported for Storybook — dashboard content for `/$orgSlug/dashboard`. */
export function OrgHomePageContent({ orgSlug }: { orgSlug: string }) {
  const [preferences, updatePreferences] = useUserPreferences()
  const { data: session, isPending: sessionPending } = useSession()
  const [activityMode, setActivityMode] = useState<ActivityMode>("organisation")
  const [activityRange, setActivityRange] = useState<ActivityRange>("7d")

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
      return await res.json()
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
  const visibleBuckets =
    activityRange === "today"
      ? buckets.slice(-1)
      : activityRange === "7d"
        ? buckets.slice(-7)
        : buckets
  const bucketMax = Math.max(
    1,
    ...visibleBuckets.map((bucket) => bucket[activityMode].total),
  )
  const activityTotal = visibleBuckets.reduce(
    (sum, bucket) => sum + bucket[activityMode].total,
    0,
  )
  const sourceTotals = {
    mcp: visibleBuckets.reduce(
      (sum, bucket) => sum + bucket[activityMode].mcp,
      0,
    ),
    ui: visibleBuckets.reduce(
      (sum, bucket) => sum + bucket[activityMode].ui,
      0,
    ),
    graph: visibleBuckets.reduce(
      (sum, bucket) => sum + bucket[activityMode].graph,
      0,
    ),
    repository: visibleBuckets.reduce(
      (sum, bucket) => sum + bucket[activityMode].repository,
      0,
    ),
    other: visibleBuckets.reduce(
      (sum, bucket) => sum + bucket[activityMode].other,
      0,
    ),
  }
  const activityRangeLabel =
    activityRange === "today"
      ? "today"
      : activityRange === "7d"
        ? "7 days"
        : "30 days"
  const querySeries = visibleBuckets.map((bucket) => bucket[activityMode].total)
  const graphUseSeries = visibleBuckets.map(
    (bucket) => bucket[activityMode].graph,
  )
  const previousBuckets =
    activityRange === "today"
      ? buckets.slice(-2, -1)
      : activityRange === "7d"
        ? buckets.slice(-14, -7)
        : []
  const previousActivityTotal = previousBuckets.reduce(
    (sum, bucket) => sum + bucket[activityMode].total,
    0,
  )
  const previousGraphTotal = previousBuckets.reduce(
    (sum, bucket) => sum + bucket[activityMode].graph,
    0,
  )
  const queryDelta =
    previousBuckets.length > 0
      ? percentDelta(activityTotal, previousActivityTotal)
      : { label: "+0%", className: "text-zinc-500" }
  const graphUseDelta =
    previousBuckets.length > 0
      ? percentDelta(sourceTotals.graph, previousGraphTotal)
      : { label: "+0%", className: "text-zinc-500" }
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
  const connectorReady = summary
    ? summary.health.connectors.github.installed +
      summary.health.connectors.forge.installed
    : 0
  const connectorDetail =
    connectorTotal > 0 ? "connectors ready" : "Connect a tool"
  const freshnessObservedAt =
    summary?.health.graph.lastObservedAt ??
    summary?.health.evidence.lastObservedAt ??
    null
  const freshnessSeries = summary
    ? summary.health.evidence.freshnessSeries
        .map((point) => point.value)
        .filter((value): value is number => value != null)
    : []
  const contextConfidenceSeries = summary
    ? summary.health.evidence.confidenceSeries
        .map((point) => point.value)
        .filter((value): value is number => value != null)
    : []
  const contextConfidenceDelta = scoreDelta(
    summary?.health.evidence.confidenceSeries ?? [],
  )
  const freshnessDelta = pointDelta(
    summary?.health.evidence.freshnessSeries ?? [],
  )
  const freshnessTotal = summary
    ? summary.health.evidence.freshness.lt24h +
      summary.health.evidence.freshness.lt7d +
      summary.health.evidence.freshness.lt30d +
      summary.health.evidence.freshness.gt30d
    : 0
  const freshWithin7d = summary
    ? summary.health.evidence.freshness.lt24h +
      summary.health.evidence.freshness.lt7d
    : 0
  const freshnessBuckets = summary
    ? [
        {
          label: "<24h",
          value: summary.health.evidence.freshness.lt24h,
          color: "#34d399",
        },
        {
          label: "1-7d",
          value: summary.health.evidence.freshness.lt7d,
          color: "#2dd4bf",
        },
        {
          label: "7-30d",
          value: summary.health.evidence.freshness.lt30d,
          color: "#fbbf24",
        },
        {
          label: ">30d",
          value: summary.health.evidence.freshness.gt30d,
          color: "#fb7185",
        },
      ]
    : []
  const freshnessInsight = summary
    ? buildFreshnessInsight({
        total: freshnessTotal,
        freshWithin7d,
        stale: summary.health.evidence.freshness.gt30d,
        lowConfidenceClaims: summary.health.evidence.lowConfidenceClaims,
        notReadyRepositories: summary.health.repositories.notReady,
        docsConnected: summary.health.confluence.spaces > 0,
      })
    : ""
  const sourceCoverageRows: SourceCoverageRow[] = summary
    ? [
        ...(summary.health.repositories.total > 0
          ? [
              {
                label: "Repositories",
                coverage: coveragePercent(
                  summary.health.repositories.indexed,
                  summary.health.repositories.total,
                ),
                detail:
                  summary.health.repositories.notReady > 0
                    ? pluralise(
                        summary.health.repositories.notReady,
                        "not ready",
                        "not ready",
                      )
                    : `${summary.health.repositories.indexed}/${summary.health.repositories.total} indexed`,
                status: summary.health.repositories.status,
              },
            ]
          : []),
        ...(summary.health.confluence.syncTargets > 0 ||
        summary.health.confluence.spaces > 0
          ? [
              {
                label: "Confluence",
                coverage:
                  summary.health.confluence.syncTargets > 0
                    ? coveragePercent(
                        summary.health.confluence.enabledTargets,
                        summary.health.confluence.syncTargets,
                      )
                    : 100,
                detail: summary.health.confluence.lastSyncedAt
                  ? `sync ${timeAgo(summary.health.confluence.lastSyncedAt)}`
                  : `${summary.health.confluence.spaces.toLocaleString()} spaces`,
                status: summary.health.confluence.status,
              },
            ]
          : []),
      ].sort(
        (a, b) => a.coverage - b.coverage || a.label.localeCompare(b.label),
      )
    : []

  return (
    <AppShell>
      <div className="flex min-h-full min-w-0 flex-1 flex-col text-foreground">
        <div className="mx-auto box-border flex w-full max-w-6xl flex-1 flex-col p-8">
          <header className="mb-8 flex items-start justify-between gap-4">
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
            <div className="flex shrink-0 items-center gap-3">
              <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                {orgSlug}
              </span>
              <button
                type="button"
                onClick={() => void refetch()}
                disabled={isFetching}
                className="inline-flex size-8 items-center justify-center border border-zinc-800 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-teal-400"
                aria-label="Refresh dashboard"
                title="Refresh dashboard"
              >
                {isFetching ? (
                  <IconRefresh className="size-4 animate-spin" aria-hidden />
                ) : (
                  <IconRefresh className="size-4" aria-hidden />
                )}
              </button>
            </div>
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
            <section className="flex min-h-[20rem] items-center justify-center p-6">
              <InlineLoader
                label="Loading context health"
                sublabel="Preparing readiness and activity"
              />
            </section>
          ) : null}

          {summary ? (
            <>
              <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <KpiCard
                  label="Freshness"
                  value={timeAgo(freshnessObservedAt)}
                  detail={freshnessDelta.label}
                  detailClassName={freshnessDelta.className}
                  series={
                    freshnessSeries.length > 0 ? freshnessSeries : undefined
                  }
                />
                <KpiCard
                  label="Queries"
                  value={activityTotal.toLocaleString()}
                  detail={queryDelta.label}
                  detailClassName={queryDelta.className}
                  series={querySeries}
                />
                <KpiCard
                  label="Graph use"
                  value={sourceTotals.graph.toLocaleString()}
                  detail={graphUseDelta.label}
                  detailClassName={graphUseDelta.className}
                  series={graphUseSeries}
                />
                <KpiCard
                  label="Context confidence"
                  value={formatScore(summary.health.evidence.contextConfidence)}
                  detail={contextConfidenceDelta.label}
                  detailClassName={contextConfidenceDelta.className}
                  series={
                    contextConfidenceSeries.length > 0
                      ? contextConfidenceSeries
                      : undefined
                  }
                />
              </section>

              <GraphTopologyBand graph={summary.health.graph} />

              <section className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <StatusStrip
                  label="Connectors"
                  value={
                    connectorTotal > 0
                      ? `${connectorReady}/${connectorTotal}`
                      : connectorLabel
                  }
                  detail={connectorDetail}
                  status={summary.health.connectors.status}
                  href={
                    connectorTotal === 0 ? `/${orgSlug}/connectors` : undefined
                  }
                />
                <StatusStrip
                  label="Repositories"
                  value={repositoryLabel}
                  detail={repositoryDetail}
                  status={summary.health.repositories.status}
                  href={
                    summary.health.repositories.total === 0
                      ? `/${orgSlug}/repositories`
                      : undefined
                  }
                />
              </section>

              <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
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
                    activity events in {activityRangeLabel}
                  </p>
                  <div className="mt-3 flex border border-zinc-800 text-xs">
                    {[
                      ["today", "Today"],
                      ["7d", "7 days"],
                      ["30d", "30 days"],
                    ].map(([range, label]) => (
                      <button
                        key={range}
                        type="button"
                        onClick={() => setActivityRange(range as ActivityRange)}
                        className={`flex-1 px-2 py-1 ${
                          activityRange === range
                            ? "bg-teal-400 text-zinc-950"
                            : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-600">
                    <span>0</span>
                    <span>Peak {bucketMax.toLocaleString()}/day</span>
                  </div>
                  <div className="mt-1 flex h-24 items-end gap-1 border border-zinc-900/95 bg-zinc-950/70 p-2">
                    {activityTotal === 0 ? (
                      <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                        No activity captured yet
                      </div>
                    ) : (
                      visibleBuckets.map((bucket) => {
                        const bucketTotal = bucket[activityMode].total
                        return (
                          <div
                            key={bucket.date}
                            className="flex min-w-0 flex-1 items-end bg-zinc-900/70"
                            title={`${bucket.date}: ${bucketTotal}`}
                          >
                            {bucketTotal > 0 ? (
                              <div
                                className="w-full bg-teal-400"
                                style={{
                                  height: `${Math.max(10, (bucketTotal / bucketMax) * 100)}%`,
                                  minHeight: "0.5rem",
                                }}
                              />
                            ) : null}
                          </div>
                        )
                      })
                    )}
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                    {[
                      ["MCP", sourceTotals.mcp],
                      ["Chat", sourceTotals.ui],
                      ["Graph", sourceTotals.graph],
                      ["Repository", sourceTotals.repository],
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

              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <section className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                    <div className="flex items-center justify-between">
                      <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                        Source coverage
                      </h2>
                      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-600">
                        Ingestion
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-zinc-500">
                      Indexed source coverage across connected tools.
                    </p>
                    <div className="mt-4 max-h-80 space-y-4 overflow-y-auto pr-1">
                      {sourceCoverageRows.map((source) => (
                        <div key={source.label} className="text-sm">
                          <div className="flex items-center justify-between gap-4">
                            <span className="text-zinc-200">
                              {source.label}
                            </span>
                            <span className="font-mono text-xs text-zinc-500">
                              {source.coverage}%
                            </span>
                          </div>
                          <div
                            className="mt-2 h-1.5 overflow-hidden bg-zinc-900"
                            aria-hidden="true"
                          >
                            <div
                              className={`h-full ${coverageBarClass(source.status)}`}
                              style={{ width: `${source.coverage}%` }}
                            />
                          </div>
                          <p className="mt-1 font-mono text-[11px] text-zinc-600">
                            {source.detail}
                          </p>
                        </div>
                      ))}
                      {sourceCoverageRows.length === 0 ? (
                        <div className="border border-zinc-900/95 bg-zinc-950 px-3 py-4 text-sm text-zinc-500">
                          Connect repositories or documentation sources to start
                          measuring source coverage.
                        </div>
                      ) : null}
                    </div>
                  </section>

                  <section className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                    <div className="flex items-center justify-between">
                      <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                        Context freshness
                      </h2>
                      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-600">
                        {dailyUpdatedLabel(summary.health.evidence.computedAt)}
                      </span>
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-4">
                      <div>
                        <p className="text-3xl font-medium tracking-tight text-zinc-100">
                          {percent(freshWithin7d, freshnessTotal)}
                        </p>
                        <p className="mt-1 text-sm text-zinc-500">
                          observed in the last 7 days
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-rose-300">
                          {summary.health.evidence.freshness.gt30d.toLocaleString()}{" "}
                          stale
                        </p>
                        <p className="mt-1 text-xs text-zinc-600">
                          over 30 days old
                        </p>
                      </div>
                    </div>
                    <div
                      className="mt-5 flex h-3 overflow-hidden bg-zinc-900"
                      aria-hidden="true"
                    >
                      {freshnessBuckets.map((bucket) =>
                        bucket.value > 0 ? (
                          <div
                            key={bucket.label}
                            style={{
                              width: percent(bucket.value, freshnessTotal),
                              backgroundColor: bucket.color,
                            }}
                          />
                        ) : null,
                      )}
                    </div>
                    <div className="mt-4 space-y-3">
                      {freshnessBuckets.map((bucket) => (
                        <div
                          key={bucket.label}
                          className="grid grid-cols-[4rem_minmax(0,1fr)_4rem_5rem] items-center gap-3 text-sm"
                        >
                          <span className="font-mono text-xs text-zinc-500">
                            {bucket.label}
                          </span>
                          <span className="flex items-center gap-2 text-zinc-400">
                            <span
                              className="size-2"
                              style={{ backgroundColor: bucket.color }}
                              aria-hidden
                            />
                            {percentLabel(bucket.value, freshnessTotal)}
                          </span>
                          <span className="text-right text-zinc-300">
                            {bucket.value.toLocaleString()}
                          </span>
                          <span className="text-right text-zinc-600">
                            claims
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-4 text-sm leading-6 text-zinc-500">
                      {freshnessInsight}
                    </p>
                  </section>
                </div>

                <section className="border border-zinc-800/95 bg-zinc-950/85 p-4">
                  <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                    Member activity
                  </h2>
                  {members ? (
                    <p className="mt-2 text-sm text-zinc-500">
                      {pluralise(activeMemberCount, "active member")} of{" "}
                      {memberCount.toLocaleString()} · ranked by 30-day activity
                    </p>
                  ) : null}
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
