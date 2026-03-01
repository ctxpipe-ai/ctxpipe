import { createFileRoute } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { authClient } from "@/lib/auth-client"

export const Route = createFileRoute("/.auth/consent")({
  component: ConsentPage,
})

function ConsentPage() {
  const [isSubmitting, setIsSubmitting] = useState<"allow" | "deny" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const searchParams = useMemo(() => {
    if (typeof window === "undefined") return new URLSearchParams()
    return new URLSearchParams(window.location.search)
  }, [])

  const clientId = searchParams.get("client_id")
  const requestedScope = searchParams.get("scope") ?? undefined
  const scopes = requestedScope?.split(" ").filter(Boolean) ?? []

  const handleConsent = async (accept: boolean) => {
    setError(null)
    setIsSubmitting(accept ? "allow" : "deny")

    const { data, error: requestError } = await authClient.oauth2.consent({
      accept,
      scope: requestedScope,
      fetchOptions: { throw: false },
    })

    if (requestError) {
      setError(requestError.message ?? "Consent failed")
      setIsSubmitting(null)
      return
    }

    const redirectUri =
      data?.redirect_uri ??
      data?.redirectUri ??
      data?.uri ??
      data?.url ??
      (typeof data === "string" ? data : undefined)

    if (redirectUri) {
      window.location.href = redirectUri
      return
    }

    setError(
      `Missing redirect URI from consent response: ${JSON.stringify(data ?? null)}`,
    )
    setIsSubmitting(null)
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-16 text-zinc-100">
      <div className="space-y-6 rounded-xl border border-zinc-800 bg-zinc-950/80 p-6">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Authorize Client</h1>
          <p className="text-sm text-zinc-400">
            The client below is requesting access to your account.
          </p>
        </div>

        <div className="space-y-2 text-sm">
          <p>
            <span className="text-zinc-400">Client ID:</span>{" "}
            <span className="font-mono">{clientId ?? "unknown"}</span>
          </p>
          <div className="space-y-1">
            <p className="text-zinc-400">Requested scopes:</p>
            {scopes.length > 0 ? (
              <ul className="list-disc pl-5 text-zinc-200">
                {scopes.map((scope) => (
                  <li key={scope} className="font-mono text-xs">
                    {scope}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-zinc-300">No scopes requested.</p>
            )}
          </div>
        </div>

        {error ? <p className="text-sm text-red-400">{error}</p> : null}

        <div className="flex gap-3">
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
            onClick={() => void handleConsent(false)}
            disabled={isSubmitting !== null}
          >
            {isSubmitting === "deny" ? "Denying..." : "Deny"}
          </button>
          <button
            type="button"
            className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:opacity-50"
            onClick={() => void handleConsent(true)}
            disabled={isSubmitting !== null}
          >
            {isSubmitting === "allow" ? "Authorizing..." : "Allow"}
          </button>
        </div>
      </div>
    </main>
  )
}
