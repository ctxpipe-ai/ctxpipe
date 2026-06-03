import {
  IconArrowRight,
  IconBook2,
  IconBrandGithub,
  IconChartBar,
  IconCheck,
  IconMessageCircle,
  IconPlug,
  IconRefresh,
  IconRobot,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, Navigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { AppShell } from "@/components/AppShell"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

export const Route = createFileRoute("/$orgSlug/")({
  component: OrgHomePage,
})

type Repository = {
  id: string
  name: string
  indexReady: boolean
}

type Connector = {
  id: string
  type: "github" | "forge"
}

type Conversation = {
  id: string
  source: string | null
  lastMessageAt: string | null
}

function toLabel(source: string | null): "UI" | "MCP" | "Graph" | "Other" {
  if (source === "ui") return "UI"
  if (source === "mcp") return "MCP"
  if (source === "knowledge-graph") return "Graph"
  return "Other"
}

function timeAgo(iso: string | null): string {
  if (!iso) return "No activity yet"
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

function OrgHomePage() {
  const { orgSlug } = Route.useParams()
  return <Navigate to="/$orgSlug/dashboard" params={{ orgSlug }} replace />
}

/** Exported for Storybook — dashboard content for `/$orgSlug/dashboard`. */
export function OrgHomePageContent({ orgSlug }: { orgSlug: string }) {
  const [preferences, updatePreferences] = useUserPreferences()
  const { data: session, isPending: sessionPending } = useSession()
  const { data: githubInstallation } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug),
    queryFn: () => fetchGithubInstallationSummary(orgSlug),
    enabled: !!session,
  })

  const { data: repositories = [], isFetching: isRepositoriesFetching } = useQuery(
    {
      queryKey: ["repositories", orgSlug],
      enabled: !!session,
      queryFn: async () => {
        const res = await client[":orgSlug"].api.v1.repositories.$get({
          param: { orgSlug },
        })
        if (!res.ok) return [] as Repository[]
        const json = (await res.json()) as { items: Repository[] }
        return json.items
      },
    },
  )

  const { data: connectors = [] } = useQuery({
    queryKey: ["connectors", orgSlug],
    enabled: !!session,
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.connectors.$get({
        param: { orgSlug },
      })
      if (!res.ok) return [] as Connector[]
      const json = (await res.json()) as { items: Connector[] }
      return json.items
    },
  })

  const { data: conversationsPayload } = useQuery({
    queryKey: ["dashboard-conversations", orgSlug],
    enabled: !!session,
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.conversations.$get({
        param: { orgSlug },
        query: { source: "all", first: "100" },
      })
      if (!res.ok) {
        return {
          items: [] as Conversation[],
          pageInfo: { hasNextPage: false },
        }
      }
      return (await res.json()) as {
        items: Conversation[]
        pageInfo: { hasNextPage: boolean }
      }
    },
  })

  const { data: graphMetrics } = useQuery({
    queryKey: ["dashboard-graph-metrics", orgSlug],
    enabled: !!session,
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1["knowledge-graph"].$get({
        param: { orgSlug },
        query: { nodeLimit: "1", edgeLimit: "1" },
      })
      if (!res.ok) return null
      const json = (await res.json()) as {
        metrics: {
          totalNodes: number
          totalEdges: number
          lastUpdatedAt: string | null
          truncated: boolean
        }
      }
      return json.metrics
    },
  })

  const githubConnected = Boolean(githubInstallation)

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
          <p className="text-sm text-zinc-400">Loading workspace…</p>
        </main>
      </AppShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const conversations = conversationsPayload?.items ?? []
  const indexedRepositoryCount = repositories.filter((repo) => repo.indexReady).length
  const repositoryCoverage =
    repositories.length === 0
      ? 0
      : Math.round((indexedRepositoryCount / repositories.length) * 100)
  const githubConnectorCount = connectors.filter((c) => c.type === "github").length
  const forgeConnectorCount = connectors.filter((c) => c.type === "forge").length
  const recent24hConversationCount = conversations.filter((c) => {
    if (!c.lastMessageAt) return false
    return Date.now() - new Date(c.lastMessageAt).getTime() <= 24 * 60 * 60 * 1000
  }).length
  const sourceCounts: Record<"UI" | "MCP" | "Graph" | "Other", number> = {
    UI: 0,
    MCP: 0,
    Graph: 0,
    Other: 0,
  }
  for (const conversation of conversations) {
    sourceCounts[toLabel(conversation.source)] += 1
  }
  const sourceRows = [
    { label: "UI", value: sourceCounts.UI, tone: "bg-sky-400" },
    { label: "MCP", value: sourceCounts.MCP, tone: "bg-teal-400" },
    { label: "Graph", value: sourceCounts.Graph, tone: "bg-violet-400" },
    { label: "Other", value: sourceCounts.Other, tone: "bg-zinc-500" },
  ]
  const sourceMax = Math.max(1, ...sourceRows.map((row) => row.value))
  const hasToolConnection = connectors.some((c) => c.type === "forge")
  const hasIndexedRepository = indexedRepositoryCount > 0
  const hasMcpActivity = sourceCounts.MCP > 0
  const setupTasks = [
    {
      label: "Connect GitHub",
      done: githubConnected,
      to: "/$orgSlug/repositories/github/setup" as const,
      icon: IconBrandGithub,
    },
    {
      label: "Connect a tool",
      done: hasToolConnection,
      to: "/$orgSlug/connectors" as const,
      icon: IconPlug,
    },
    {
      label: "Index a repository",
      done: hasIndexedRepository,
      to: "/$orgSlug/repositories" as const,
      icon: IconBook2,
    },
    {
      label: "Query your context layer",
      done: hasMcpActivity,
      to: "/$orgSlug/chat" as const,
      icon: IconMessageCircle,
    },
  ]
  const setupComplete = setupTasks.every((task) => task.done)

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
                Workspace dashboard
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Live view of activity, context readiness, and graph health.
              </p>
            </div>
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              {orgSlug}
            </span>
          </header>

          <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-none border border-zinc-800/95 bg-zinc-950/85 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Repositories
              </p>
              <p className="mt-3 text-3xl font-medium text-zinc-100">
                {repositories.length}
              </p>
              <p className="mt-2 text-sm text-zinc-400">
                {indexedRepositoryCount} indexed ({repositoryCoverage}%)
              </p>
            </article>
            <article className="rounded-none border border-zinc-800/95 bg-zinc-950/85 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Connectors
              </p>
              <p className="mt-3 text-3xl font-medium text-zinc-100">
                {connectors.length}
              </p>
              <p className="mt-2 text-sm text-zinc-400">
                {githubConnectorCount} GitHub, {forgeConnectorCount} Forge
              </p>
            </article>
            <article className="rounded-none border border-zinc-800/95 bg-zinc-950/85 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Conversations
              </p>
              <p className="mt-3 text-3xl font-medium text-zinc-100">
                {conversations.length}
                {conversationsPayload?.pageInfo.hasNextPage ? "+" : ""}
              </p>
              <p className="mt-2 text-sm text-zinc-400">
                {recent24hConversationCount} in last 24h (latest 100)
              </p>
            </article>
            <article className="rounded-none border border-zinc-800/95 bg-zinc-950/85 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Knowledge graph
              </p>
              <p className="mt-3 text-3xl font-medium text-zinc-100">
                {(graphMetrics?.totalNodes ?? 0).toLocaleString()}
              </p>
              <p className="mt-2 text-sm text-zinc-400">
                {(graphMetrics?.totalEdges ?? 0).toLocaleString()} edges
              </p>
            </article>
          </section>

          <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
            <section
              className={`rounded-none border border-zinc-800/95 bg-zinc-950/85 p-4 ${setupComplete ? "xl:col-span-3" : "xl:col-span-2"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                  Activity by source
                </h2>
                <span className="text-xs text-zinc-500">latest 100</span>
              </div>
              <div className="mt-4 space-y-3">
                {sourceRows.map((row) => (
                  <div key={row.label}>
                    <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                      <span>{row.label}</span>
                      <span>{row.value}</span>
                    </div>
                    <div className="h-2 bg-zinc-900/90">
                      <div
                        className={`h-2 ${row.tone}`}
                        style={{ width: `${(row.value / sourceMax) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {!setupComplete ? (
              <section className="rounded-none border border-zinc-800/95 bg-zinc-950/85 p-4">
                <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                  Setup status
                </h2>
                <ul className="mt-4 space-y-2">
                  {setupTasks.map((task) => (
                    <Link
                      key={task.label}
                      to={task.to}
                      params={{ orgSlug }}
                      className="flex items-center justify-between border border-zinc-900/95 bg-zinc-950 px-3 py-2 transition-colors hover:border-zinc-700 hover:bg-zinc-900/80"
                    >
                      <span className="inline-flex items-center gap-2 text-sm text-zinc-200">
                        <task.icon className="size-4 text-zinc-500" />
                        {task.label}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 text-xs ${task.done ? "text-teal-300" : "text-zinc-500"}`}
                      >
                        {task.done ? (
                          <>
                            <IconCheck className="size-3.5" />
                            Done
                          </>
                        ) : (
                          <IconArrowRight className="size-3.5" />
                        )}
                      </span>
                    </Link>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <section className="rounded-none border border-zinc-800/95 bg-zinc-950/85 p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                  Recent conversation activity
                </h2>
                <IconRobot className="size-4 text-zinc-500" aria-hidden />
              </div>
              <ul className="mt-4 space-y-2">
                {conversations.slice(0, 6).map((conversation) => (
                  <li
                    key={conversation.id}
                    className="flex items-center justify-between border border-zinc-900/95 bg-zinc-950 px-3 py-2"
                  >
                    <span className="text-sm text-zinc-200">
                      {toLabel(conversation.source)}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {timeAgo(conversation.lastMessageAt)}
                    </span>
                  </li>
                ))}
                {conversations.length === 0 ? (
                  <li className="border border-zinc-900/95 bg-zinc-950 px-3 py-4 text-sm text-zinc-500">
                    No activity yet. Start a chat or connect an agent via MCP.
                  </li>
                ) : null}
              </ul>
            </section>

            <section className="rounded-none border border-zinc-800/95 bg-zinc-950/85 p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
                  Context status
                </h2>
                <IconChartBar className="size-4 text-zinc-500" aria-hidden />
              </div>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between border border-zinc-900/95 bg-zinc-950 px-3 py-2">
                  <span className="text-zinc-400">Index coverage</span>
                  <span className="text-zinc-100">{repositoryCoverage}%</span>
                </div>
                <div className="flex items-center justify-between border border-zinc-900/95 bg-zinc-950 px-3 py-2">
                  <span className="text-zinc-400">Graph nodes</span>
                  <span className="text-zinc-100">
                    {(graphMetrics?.totalNodes ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between border border-zinc-900/95 bg-zinc-950 px-3 py-2">
                  <span className="text-zinc-400">Graph edges</span>
                  <span className="text-zinc-100">
                    {(graphMetrics?.totalEdges ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between border border-zinc-900/95 bg-zinc-950 px-3 py-2">
                  <span className="text-zinc-400">Last graph update</span>
                  <span className="text-zinc-100">
                    {timeAgo(graphMetrics?.lastUpdatedAt ?? null)}
                  </span>
                </div>
                <div className="flex items-center justify-between border border-zinc-900/95 bg-zinc-950 px-3 py-2">
                  <span className="text-zinc-400">Data refresh</span>
                  <span className="inline-flex items-center gap-1 text-zinc-100">
                    <IconRefresh
                      className={`size-3.5 ${isRepositoriesFetching ? "animate-spin text-teal-400" : "text-zinc-500"}`}
                      aria-hidden
                    />
                    {isRepositoriesFetching ? "Refreshing" : "Live"}
                  </span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
