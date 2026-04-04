import { createFileRoute, Link } from "@tanstack/react-router"
import { IconAlertTriangle } from "@tabler/icons-react"

export const Route = createFileRoute("/oauth/error")({
  component: OAuthErrorPage,
})

const ERROR_MESSAGES: Record<string, string> = {
  invalid_state: "The authorisation request expired or was already used. Please try connecting again.",
  token_exchange_failed: "Failed to exchange the authorisation code for tokens. Please try again.",
  no_refresh_token: "Atlassian did not return a refresh token. Make sure 'offline_access' is requested.",
  no_accessible_sites: "No Confluence sites were found on your Atlassian account.",
  cloudid_resolution_failed: "Could not determine your Confluence Cloud ID. Please try again.",
  connector_not_found: "The connector associated with this authorisation could not be found.",
  missing_params: "The callback was missing required parameters.",
}

function OAuthErrorPage() {
  const { reason } = Route.useSearch() as { reason?: string }
  const message = (reason && ERROR_MESSAGES[reason]) ?? "An unexpected error occurred during authorisation."

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-md rounded-xl border border-red-800/40 bg-zinc-900 p-8 text-center shadow-xl">
        <div className="mb-4 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-900/30">
            <IconAlertTriangle className="h-6 w-6 text-red-400" />
          </div>
        </div>
        <h1 className="mb-2 text-xl font-semibold text-zinc-100">
          Authorisation failed
        </h1>
        <p className="mb-6 text-sm text-zinc-400">{message}</p>
        {reason && (
          <p className="mb-6 font-mono text-xs text-zinc-600">reason: {reason}</p>
        )}
        <Link
          to="/"
          className="inline-flex items-center rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 transition-colors"
        >
          Back to app
        </Link>
      </div>
    </div>
  )
}
