import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import type { FormEvent } from "react"
import { useState } from "react"

import { AuthLogoBadge } from "@/components/Logo/Logo"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Spinner } from "@/components/ui/spinner"
import { authClient, useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/.auth/device")({
  validateSearch: (raw: Record<string, unknown>) => ({
    user_code: typeof raw.user_code === "string" ? raw.user_code : undefined,
  }),
  component: DeviceAuthorizationPage,
})

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "object" && error != null) {
    const maybeMessage = (error as { message?: unknown }).message
    if (typeof maybeMessage === "string" && maybeMessage.length > 0) {
      return maybeMessage
    }
  }
  return "Request failed. Please try again."
}

function normalizeUserCode(value: string): string {
  return value.trim().replace(/-/g, "").toUpperCase()
}

function devicePathWithSearch(search: { user_code?: string }): string {
  if (!search.user_code) return "/.auth/device"
  const qs = new URLSearchParams({ user_code: search.user_code })
  return `/.auth/device?${qs.toString()}`
}

/**
 * Shows the device authorization page, where a person enters or confirms the code that a CLI or device shows, and then approves or denies it.
 * It is exported so that the stories can render it.
 */
export function DeviceAuthorizationPage() {
  const search = Route.useSearch()
  const { data: session, isPending: sessionPending } = useSession()
  const initialCode = normalizeUserCode(search.user_code ?? "")
  const hasPrefilledCode = initialCode.length > 0
  const [submittedCode, setSubmittedCode] = useState(initialCode)
  const [inputCode, setInputCode] = useState(initialCode)

  const currentPath = devicePathWithSearch(search)
  const signInHref = `/.auth/sign-in?redirectTo=${encodeURIComponent(currentPath)}`

  const codeQuery = useQuery({
    queryKey: ["device-code", submittedCode],
    queryFn: async () => {
      const { data, error } = await authClient.device({
        query: { user_code: submittedCode },
        fetchOptions: { throw: false },
      })
      if (error) throw new Error(error.message ?? "Invalid or expired code")
      return data
    },
    enabled: submittedCode.length > 0,
    retry: false,
  })

  const approveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.device.approve({
        userCode: submittedCode,
        fetchOptions: { throw: false },
      })
      if (error) throw new Error(error.message ?? "Could not approve device")
    },
  })

  const denyMutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.device.deny({
        userCode: submittedCode,
        fetchOptions: { throw: false },
      })
      if (error) throw new Error(error.message ?? "Could not deny device")
    },
  })

  const deviceStatus = codeQuery.data?.status
  const mutationError = approveMutation.error ?? denyMutation.error
  const isSubmitting = approveMutation.isPending || denyMutation.isPending

  const submitCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextCode = normalizeUserCode(inputCode)
    if (!nextCode) return
    setSubmittedCode(nextCode)
  }

  return (
    <main className="hero-gradient min-h-screen bg-zinc-950 text-foreground">
      <div className="mx-auto flex min-h-screen max-w-md items-center px-6 py-16">
        <div className="relative mx-auto w-full max-w-sm">
          <AuthLogoBadge />
          <section className="ctx-border ctx-surface px-6 pt-24 pb-6 shadow-none">
            <div className="space-y-2 text-center">
              <h1 className="text-lg font-semibold text-zinc-100">
                Authorize ctxpipe CLI
              </h1>
              <p className="text-sm text-zinc-400">
                Approve this request to let the CLI load your organizations for
                setup.
              </p>
              {session && typeof session.user.email === "string" ? (
                <p className="text-xs text-zinc-500">
                  Signed in as{" "}
                  <span className="font-mono text-zinc-400">
                    {session.user.email}
                  </span>
                  {" · "}
                  <a
                    href={`/.auth/sign-out?redirectTo=${encodeURIComponent(currentPath)}`}
                    className="text-teal-400 hover:text-teal-300 hover:underline"
                  >
                    Sign out
                  </a>
                </p>
              ) : null}
            </div>

            {hasPrefilledCode ? null : (
              <form onSubmit={submitCode} className="mt-6 grid gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-zinc-300">Device code</span>
                  <input
                    value={inputCode}
                    onChange={(event) => setInputCode(event.target.value)}
                    placeholder="ABCD-1234"
                    className="h-10 w-full rounded-md border border-border bg-zinc-950 px-3 font-mono text-zinc-100"
                  />
                </label>
                <Button
                  type="submit"
                  variant="secondary"
                  className="rounded-md"
                  isDisabled={!inputCode.trim() || codeQuery.isFetching}
                >
                  {codeQuery.isFetching ? "Checking..." : "Check code"}
                </Button>
              </form>
            )}

            {submittedCode && codeQuery.isPending ? (
              <div className="mt-5 flex items-center justify-center gap-2 text-sm text-zinc-400">
                <Spinner className="h-4 w-4" />
                Checking request...
              </div>
            ) : null}

            {codeQuery.error ? (
              <p className="mt-4 text-sm text-red-400">
                {extractErrorMessage(codeQuery.error)}
              </p>
            ) : null}

            {codeQuery.data ? (
              <div className="mt-5 grid gap-4">
                {/* A link can carry a code that another person's CLI started
                    (GHSA-q84f-53jg-9ppm), so the page never approves by
                    itself: the person compares the code with their terminal
                    and presses Approve. */}
                <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
                  <p className="text-zinc-400">Request code</p>
                  <p className="font-mono text-zinc-100">{submittedCode}</p>
                </div>
                <InlineAlert variant="warning">
                  Approve only if you started the sign-in in your own terminal
                  and it shows this code.
                </InlineAlert>

                {sessionPending ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-zinc-400">
                    <Spinner className="h-4 w-4" />
                    Checking sign-in...
                  </div>
                ) : session ? (
                  approveMutation.isSuccess || deviceStatus === "approved" ? (
                    <p className="text-sm text-teal-400">
                      Approved. Return to your terminal to continue setup.
                    </p>
                  ) : denyMutation.isSuccess || deviceStatus === "denied" ? (
                    <p className="text-sm text-zinc-400">
                      Denied. You can close this tab.
                    </p>
                  ) : (
                    <div className="flex gap-3">
                      <Button
                        type="button"
                        variant="secondary"
                        className="flex-1 rounded-md"
                        onPress={() => denyMutation.mutate()}
                        isDisabled={isSubmitting}
                      >
                        {denyMutation.isPending ? "Denying..." : "Deny"}
                      </Button>
                      <Button
                        type="button"
                        className="flex-1 rounded-md"
                        onPress={() => approveMutation.mutate()}
                        isDisabled={isSubmitting}
                      >
                        {approveMutation.isPending ? "Approving..." : "Approve"}
                      </Button>
                    </div>
                  )
                ) : (
                  <a
                    href={signInHref}
                    className="inline-flex h-9 items-center justify-center rounded-md bg-zinc-100 px-3.5 text-sm font-medium text-zinc-950 hover:bg-zinc-200"
                  >
                    Sign in to approve
                  </a>
                )}

                {mutationError ? (
                  <p className="text-sm text-red-400">
                    {extractErrorMessage(mutationError)}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  )
}
