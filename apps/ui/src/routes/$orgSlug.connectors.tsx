import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { Navigate } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { useQuery } from "@tanstack/react-query"
import { client } from "@/lib/api"
import { useState } from "react"
import { ConnectorCard, ConnectorSetupDialog } from "@/features/connectors"

export const Route = createFileRoute("/$orgSlug/connectors")({
  component: ConnectorsPage,
})

function ConnectorsPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const { orgSlug } = Route.useParams()
  const [setupOpen, setSetupOpen] = useState(false)

  const { data: status, isPending: statusPending } = useQuery({
    queryKey: ["connectors-atlassian-status", orgSlug],
    queryFn: async () => {
      const res = await (
        client[":orgSlug"].api.v1.connectors.atlassian.status.$get as (arg: {
          param: { orgSlug: string }
        }) => Promise<Response>
      )({ param: { orgSlug } })
      if (!res.ok) throw new Error("Failed to fetch connector status")
      return res.json() as Promise<{
        isLinked: boolean
        isInstalled: boolean
        selectedPageCount: number
      }>
    },
    enabled: !!session,
  })

  if (sessionPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const statusLabel = statusPending
    ? "Checking status..."
    : status?.isInstalled
      ? status.selectedPageCount > 0
        ? "Connected and configured"
        : "Connected, awaiting content selection"
      : status?.isLinked
        ? "Linked, app not installed"
        : "Not connected"

  return (
    <AppShell>
      <main className="mx-auto max-w-5xl px-2 py-2 text-zinc-100 sm:px-6 sm:py-10">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-zinc-50">Connectors</h1>
          <p className="text-sm text-zinc-400">
            Connect external tools and choose what content ctxpipe should ingest.
          </p>
        </div>

        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <ConnectorCard
            title="Atlassian Confluence"
            description="Sync spaces and pages from your Confluence instance."
            statusLabel={statusLabel}
            onSetup={() => setSetupOpen(true)}
          />
        </section>

        <ConnectorSetupDialog
          orgSlug={orgSlug}
          isOpen={setupOpen}
          onOpenChange={setSetupOpen}
        />
      </main>
    </AppShell>
  )
}
