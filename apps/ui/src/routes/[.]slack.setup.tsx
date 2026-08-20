import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { SLACK_SETUP_RESULT_KEY } from "@/features/connectors/components/SlackSetupDialog"

export const Route = createFileRoute("/.slack/setup")({
  validateSearch: (search: Record<string, unknown>) => ({
    orgSlug: typeof search.orgSlug === "string" ? search.orgSlug : undefined,
    connectionId:
      typeof search.connectionId === "string" ? search.connectionId : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: SlackSetupRelayPage,
})

function SlackSetupRelayPage() {
  const search = Route.useSearch()

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SLACK_SETUP_RESULT_KEY,
        JSON.stringify({
          connectionId: search.connectionId,
          error: search.error,
        }),
      )
    } catch {
      // ignore
    }
    window.close()
  }, [search.connectionId, search.error])

  return (
    <main className="flex min-h-screen items-center justify-center p-8 text-sm text-muted-foreground">
      {search.error
        ? `Slack setup failed: ${search.error}`
        : "Slack connected. You can close this window."}
    </main>
  )
}
