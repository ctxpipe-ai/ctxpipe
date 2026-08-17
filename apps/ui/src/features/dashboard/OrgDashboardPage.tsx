import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconChevronDown,
  IconRefresh,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { Navigate } from "@tanstack/react-router"
import type { InferResponseType } from "hono/client"
import { useEffect } from "react"
import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

type DashboardSummary = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["dashboard"]["summary"]["$get"],
  200
>
type DashboardStatus = DashboardSummary["health"]["overall"]

type ConnectorFamily = {
  label: string
  ready: number
  total: number
  failed: number
  needsSetup: number
}

type ReadinessView = {
  status: DashboardStatus
  eyebrow: string
  title: string
  detail: string
}

function pluralise(count: number, singular: string, plural = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

function formatOptionalNumber(value: number | null): string {
  return value == null ? "Preparing" : value.toLocaleString()
}

function formatOptionalDecimal(value: number | null): string {
  if (value == null) return "Preparing"
  if (value >= 100) return Math.round(value).toLocaleString()
  return value.toFixed(1)
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Not measured yet"
  const deltaMs = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "Just now"
  const mins = Math.floor(deltaMs / 60_000)
  if (mins < 1) return "Just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function percentage(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)))
}

function connectorFamilies(
  health: DashboardSummary["health"],
): ConnectorFamily[] {
  const connectors = health.connectors
  return [
    {
      label: "GitHub",
      ready: connectors.github.installed,
      total: connectors.github.total,
      failed: 0,
      needsSetup: connectors.github.needsSetup,
    },
    {
      label: "Confluence",
      ready: connectors.forge.installed,
      total: connectors.forge.total,
      failed: connectors.forge.failed,
      needsSetup: Math.max(
        connectors.forge.running,
        health.confluence.status === "warning" ? 1 : 0,
      ),
    },
    {
      label: "Linear",
      ready: connectors.linear.ready,
      total: connectors.linear.total,
      failed: connectors.linear.failed,
      needsSetup: connectors.linear.needsSetup,
    },
    {
      label: "Notion",
      ready: connectors.notion.ready,
      total: connectors.notion.total,
      failed: connectors.notion.failed,
      needsSetup: connectors.notion.needsSetup,
    },
  ].filter((family) => family.total > 0)
}

function familyStatus(family: ConnectorFamily): DashboardStatus {
  if (family.failed > 0) return "error"
  if (family.needsSetup > 0 || family.ready < family.total) return "warning"
  return "ok"
}

function familyDetail(family: ConnectorFamily): string {
  if (family.failed > 0) {
    return pluralise(family.failed, "sync failed", "syncs failed")
  }
  if (family.needsSetup > 0) {
    return pluralise(family.needsSetup, "needs setup", "need setup")
  }
  return `${family.ready}/${family.total} ready`
}

function statusLabel(status: DashboardStatus): string {
  if (status === "ok") return "Ready"
  if (status === "warning") return "Needs attention"
  if (status === "error") return "Action required"
  return "Preparing"
}

function statusTextClass(status: DashboardStatus): string {
  if (status === "ok") return "text-teal-300"
  if (status === "warning") return "text-amber-300"
  if (status === "error") return "text-red-300"
  return "text-zinc-400"
}

function statusDotClass(status: DashboardStatus): string {
  if (status === "ok") return "ctx-indexed-dot"
  if (status === "warning") return "ctx-indexing-dot"
  if (status === "error") return "ctx-indexing-failed-dot"
  return "size-2 rounded-full bg-zinc-600"
}

function readinessView(
  summary: DashboardSummary,
  families: ConnectorFamily[],
): ReadinessView {
  const repositoryTotal = summary.health.repositories.total
  const connectorTotal = families.reduce((sum, family) => sum + family.total, 0)
  const errorCount = summary.actions.filter(
    (action) => action.severity === "error",
  ).length
  const warningCount = summary.actions.filter(
    (action) => action.severity === "warning",
  ).length
  if (repositoryTotal === 0 && connectorTotal === 0) {
    return {
      status: "warning",
      eyebrow: "Set up your context",
      title: "Connect the work your team relies on",
      detail:
        "Add code, issues, and documentation so AI agents can work from the same organisational context as your team.",
    }
  }
  if (errorCount > 0) {
    return {
      status: "error",
      eyebrow: "Agent context is at risk",
      title: `${pluralise(errorCount, "issue")} requires action`,
      detail:
        "One or more sources cannot keep context current. Resolve the failures below before relying on agent answers.",
    }
  }
  if (warningCount > 0) {
    return {
      status: "warning",
      eyebrow: "Agent context needs attention",
      title: `${pluralise(warningCount, "task")} left to complete`,
      detail:
        "Your connected context is partly available, but setup or indexing work below is limiting coverage.",
    }
  }
  if (repositoryTotal > 0 && summary.health.evidence.activeClaims === 0) {
    return {
      status: "unknown",
      eyebrow: "Agent context is building",
      title: "Sources are connected and indexing",
      detail:
        "Repositories are available, but ctxpipe is still extracting the context agents will use.",
    }
  }
  if (!summary.health.evidence.computedAt) {
    return {
      status: "unknown",
      eyebrow: "Agent context is building",
      title: "Sources are connected",
      detail:
        "Agents can use the connected sources now. Daily freshness and quality signals are still being prepared.",
    }
  }
  return {
    status: "ok",
    eyebrow: "Agent context is ready",
    title: "Agent context is available",
    detail:
      "Sources are connected, repositories are indexed, and there are no open setup or reliability actions.",
  }
}

function StatusIndicator({
  status,
  label = statusLabel(status),
}: {
  status: DashboardStatus
  label?: string
}) {
  return (
    <span
      className={`flex shrink-0 items-center gap-2 font-mono text-xs ${statusTextClass(status)}`}
    >
      <span className={statusDotClass(status)} aria-hidden />
      {label}
    </span>
  )
}

function SourceRow({
  label,
  detail,
  status,
  href,
}: {
  label: string
  detail: string
  status: DashboardStatus
  href: string
}) {
  return (
    <a
      href={href}
      className="group flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-white/[0.04]"
    >
      <span className={statusDotClass(status)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {detail}
        </span>
      </span>
      <IconArrowRight
        className="size-4 shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-300"
        aria-hidden
      />
    </a>
  )
}

/** Exported for Storybook — dashboard content for `/$orgSlug/dashboard`. */
export function OrgDashboardPage({ orgSlug }: { orgSlug: string }) {
  const [preferences, updatePreferences] = useUserPreferences()
  const { data: session, isPending: sessionPending } = useSession()
  const {
    data: summary,
    isFetching,
    isPending,
    error,
    refetch,
  } = useQuery({
    queryKey: ["dashboard-summary", orgSlug],
    enabled: Boolean(session),
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.dashboard.summary.$get({
        param: { orgSlug },
        query: { range: "30d" },
      })
      if (!res.ok) throw new Error(`Dashboard summary failed: ${res.status}`)
      return await res.json()
    },
  })

  useEffect(() => {
    if (preferences.selectedOrganizationSlug !== orgSlug) {
      updatePreferences((previous) => ({
        ...previous,
        selectedOrganizationSlug: orgSlug,
      }))
    }
  }, [orgSlug, preferences.selectedOrganizationSlug, updatePreferences])

  if (sessionPending) {
    return (
      <AppShell>
        <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-6 py-8">
          <output
            className="block w-full animate-pulse space-y-4"
            aria-label="Loading dashboard"
          >
            <div className="h-7 w-44 rounded-lg bg-zinc-900" />
            <div className="h-40 rounded-lg bg-zinc-900/70" />
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="h-64 rounded-lg bg-zinc-900/70 lg:col-span-2" />
              <div className="h-64 rounded-lg bg-zinc-900/70" />
            </div>
          </output>
        </main>
      </AppShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const families = summary ? connectorFamilies(summary.health) : []
  const readiness = summary ? readinessView(summary, families) : null
  const connectorTotal = families.reduce((sum, family) => sum + family.total, 0)
  const connectorReady = families.reduce((sum, family) => sum + family.ready, 0)
  const isEmpty =
    summary != null &&
    connectorTotal === 0 &&
    summary.health.repositories.total === 0
  const freshness = summary?.health.evidence.freshness
  const freshnessTotal = freshness
    ? freshness.lt24h + freshness.lt7d + freshness.lt30d + freshness.gt30d
    : 0
  const freshWithin7d = freshness ? freshness.lt24h + freshness.lt7d : 0
  const freshPercent = percentage(freshWithin7d, freshnessTotal)
  const activityBuckets = summary?.activity.buckets.slice(-7) ?? []
  const activityTotal = activityBuckets.reduce(
    (sum, bucket) => sum + bucket.organisation.total,
    0,
  )
  const activityBySource = {
    mcp: activityBuckets.reduce(
      (sum, bucket) => sum + bucket.organisation.mcp,
      0,
    ),
    chat: activityBuckets.reduce(
      (sum, bucket) => sum + bucket.organisation.ui,
      0,
    ),
    repository: activityBuckets.reduce(
      (sum, bucket) => sum + bucket.organisation.repository,
      0,
    ),
  }

  return (
    <AppShell>
      <main className="min-w-0 flex-1 text-foreground">
        <div className="mx-auto box-border flex w-full max-w-5xl flex-col px-6 py-8">
          <header className="mb-6 flex items-start justify-between gap-4">
            <div>
              <span className="ctx-label text-teal-400">Dashboard</span>
              <h1 className="mt-2 text-xl font-medium">Context readiness</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                What your AI agents can rely on, and what needs attention.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onPress={() => void refetch()}
              isDisabled={isFetching}
              aria-label="Refresh dashboard"
            >
              <IconRefresh
                className={`size-4 ${isFetching ? "animate-spin" : ""}`}
                aria-hidden
              />
            </Button>
          </header>

          {error ? (
            <InlineAlert variant="error" title="Dashboard data is unavailable">
              Readiness could not be checked. Existing sources have not been
              assumed healthy or unhealthy.
            </InlineAlert>
          ) : null}

          {isPending ? (
            <output
              className="block animate-pulse space-y-4"
              aria-label="Loading dashboard"
            >
              <div className="h-40 rounded-lg bg-zinc-900/70" />
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="h-64 rounded-lg bg-zinc-900/70 lg:col-span-2" />
                <div className="h-64 rounded-lg bg-zinc-900/70" />
              </div>
            </output>
          ) : null}

          {summary && readiness ? (
            <>
              <section
                className={[
                  "rounded-lg border p-6",
                  readiness.status === "error"
                    ? "border-red-500/35 bg-red-950/20"
                    : readiness.status === "warning"
                      ? "border-amber-500/30 bg-amber-950/15"
                      : readiness.status === "ok"
                        ? "border-teal-500/30 bg-teal-950/15"
                        : "border-border bg-card",
                ].join(" ")}
              >
                <div className="flex items-start gap-4">
                  <span
                    className={[
                      "ctx-node mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg",
                      statusTextClass(readiness.status),
                    ].join(" ")}
                  >
                    {readiness.status === "ok" ? (
                      <IconCheck className="size-5" aria-hidden />
                    ) : (
                      <IconAlertTriangle className="size-5" aria-hidden />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`font-mono text-xs uppercase tracking-[0.18em] ${statusTextClass(readiness.status)}`}
                    >
                      {readiness.eyebrow}
                    </p>
                    <h2 className="mt-2 text-2xl font-medium tracking-tight">
                      {readiness.title}
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                      {readiness.detail}
                    </p>
                    {isEmpty ? (
                      <a
                        href={`/${orgSlug}/connectors`}
                        className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
                      >
                        Connect sources
                        <IconArrowRight className="size-4" aria-hidden />
                      </a>
                    ) : summary.actions.length > 0 ? (
                      <a
                        href="#action-queue"
                        className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-amber-200 hover:text-amber-100"
                      >
                        Review open actions
                        <IconArrowRight className="size-4" aria-hidden />
                      </a>
                    ) : null}
                  </div>
                </div>
              </section>

              {!isEmpty ? (
                <div className="mt-4 grid gap-4 lg:grid-cols-3">
                  <section
                    id="action-queue"
                    className="rounded-lg border border-border bg-card p-4 lg:col-span-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-base font-medium">
                          What needs attention
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Concrete work that improves agent grounding.
                        </p>
                      </div>
                      <span className="font-mono text-xs text-zinc-500">
                        {summary.actions.length} open
                      </span>
                    </div>
                    <div className="mt-4 space-y-2">
                      {summary.actions.map((action) => (
                        <a
                          key={`${action.title}:${action.href}`}
                          href={action.href}
                          className={[
                            "group flex items-center gap-4 rounded-lg border px-4 py-3 transition-colors",
                            action.severity === "error"
                              ? "border-red-500/30 bg-red-950/20 hover:border-red-500/50"
                              : "border-amber-500/25 bg-amber-950/15 hover:border-amber-500/45",
                          ].join(" ")}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">
                              {action.title}
                            </span>
                            <span className="mt-1 block text-sm text-muted-foreground">
                              {action.detail}
                            </span>
                          </span>
                          <IconArrowRight
                            className="size-4 shrink-0 text-zinc-500 transition-colors group-hover:text-zinc-200"
                            aria-hidden
                          />
                        </a>
                      ))}
                      {summary.actions.length === 0 ? (
                        <div className="flex items-center gap-3 rounded-lg border border-teal-500/25 bg-teal-950/15 px-4 py-4">
                          <IconCheck
                            className="size-4 shrink-0 text-teal-300"
                            aria-hidden
                          />
                          <div>
                            <p className="text-sm font-medium text-teal-100">
                              No action needed
                            </p>
                            <p className="mt-0.5 text-sm text-teal-100/70">
                              Connected sources and repositories are ready.
                            </p>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </section>

                  <section className="rounded-lg border border-border bg-card p-4">
                    <h2 className="text-base font-medium">Connected sources</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {connectorTotal > 0
                        ? `${connectorReady}/${connectorTotal} connections ready`
                        : "No tool connections"}
                    </p>
                    <div className="mt-3 divide-y divide-white/[0.06]">
                      {families.map((family) => (
                        <SourceRow
                          key={family.label}
                          label={family.label}
                          detail={familyDetail(family)}
                          status={familyStatus(family)}
                          href={`/${orgSlug}/connectors`}
                        />
                      ))}
                      <SourceRow
                        label="Repositories"
                        detail={
                          summary.health.repositories.total === 0
                            ? "None connected"
                            : summary.health.repositories.notReady > 0
                              ? `${summary.health.repositories.indexed}/${summary.health.repositories.total} indexed · ${summary.health.repositories.notReady} need attention`
                              : `${summary.health.repositories.indexed}/${summary.health.repositories.total} indexed`
                        }
                        status={summary.health.repositories.status}
                        href={`/${orgSlug}/repositories`}
                      />
                    </div>
                  </section>
                </div>
              ) : null}

              {!isEmpty ? (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <section className="rounded-lg border border-border bg-card p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h2 className="text-base font-medium">
                          Context freshness
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Last measured{" "}
                          {timeAgo(summary.health.evidence.computedAt)}
                        </p>
                      </div>
                      <StatusIndicator
                        status={summary.health.evidence.status}
                      />
                    </div>
                    {freshnessTotal > 0 ? (
                      <>
                        <div className="mt-6 flex items-end justify-between gap-4">
                          <div>
                            <p className="text-3xl font-medium tabular-nums">
                              {freshPercent}%
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              checked in the last 7 days
                            </p>
                          </div>
                          <div className="text-right">
                            <p
                              className={
                                freshness?.gt30d
                                  ? "text-sm text-amber-300"
                                  : "text-sm text-teal-300"
                              }
                            >
                              {freshness?.gt30d.toLocaleString()} stale
                            </p>
                            <p className="mt-1 text-xs text-zinc-600">
                              over 30 days old
                            </p>
                          </div>
                        </div>
                        <div
                          role="progressbar"
                          className="mt-5 h-2 overflow-hidden rounded-full bg-zinc-900"
                          aria-label={`${freshPercent}% of context checked in the last 7 days`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={freshPercent}
                        >
                          <div
                            className="h-full rounded-full bg-teal-400"
                            style={{ width: `${freshPercent}%` }}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="mt-6 rounded-lg bg-zinc-950/70 px-4 py-5">
                        <p className="text-sm font-medium">
                          Daily metrics are preparing
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Freshness will appear after context has been extracted
                          and the daily snapshot has run.
                        </p>
                      </div>
                    )}
                  </section>

                  <section className="rounded-lg border border-border bg-card p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h2 className="text-base font-medium">
                          Recent activity
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Context activity captured in the last 7 days.
                        </p>
                      </div>
                      <span className="font-mono text-xs text-zinc-500">
                        7 days
                      </span>
                    </div>
                    <p className="mt-6 text-3xl font-medium tabular-nums">
                      {activityTotal.toLocaleString()}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      recorded events
                    </p>
                    <dl className="mt-5 grid grid-cols-3 gap-2">
                      {[
                        ["MCP", activityBySource.mcp],
                        ["Chat", activityBySource.chat],
                        ["Repository", activityBySource.repository],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="rounded-lg bg-zinc-950/70 px-3 py-3"
                        >
                          <dt className="text-xs text-zinc-500">{label}</dt>
                          <dd className="mt-1 font-mono text-sm tabular-nums">
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                </div>
              ) : null}

              {!isEmpty ? (
                <details className="group mt-4 rounded-lg border border-border bg-card">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
                    <span>
                      <span className="block text-sm font-medium">
                        Technical details
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Graph and extraction diagnostics for deeper
                        investigation.
                      </span>
                    </span>
                    <IconChevronDown
                      className="size-4 text-zinc-500 transition-transform group-open:rotate-180"
                      aria-hidden
                    />
                  </summary>
                  <div className="grid gap-4 border-t border-border px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      [
                        "Graph entities",
                        formatOptionalNumber(summary.health.graph.totalNodes),
                      ],
                      [
                        "Relationships",
                        formatOptionalNumber(summary.health.graph.totalEdges),
                      ],
                      [
                        "Isolated entities",
                        formatOptionalNumber(
                          summary.health.graph.isolatedNodes,
                        ),
                      ],
                      [
                        "Average degree",
                        formatOptionalDecimal(
                          summary.health.graph.averageDegree,
                        ),
                      ],
                      [
                        "Context facts",
                        summary.health.evidence.activeClaims.toLocaleString(),
                      ],
                      [
                        "Instruction units",
                        summary.health.evidence.instructionUnits.toLocaleString(),
                      ],
                      [
                        "Internal confidence",
                        summary.health.evidence.contextConfidence == null
                          ? "Preparing"
                          : summary.health.evidence.contextConfidence.toFixed(
                              2,
                            ),
                      ],
                      ["Snapshot", timeAgo(summary.health.evidence.computedAt)],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <p className="font-mono text-xs text-zinc-500">
                          {label}
                        </p>
                        <p className="mt-1 text-sm font-medium tabular-nums">
                          {value}
                        </p>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      </main>
    </AppShell>
  )
}
