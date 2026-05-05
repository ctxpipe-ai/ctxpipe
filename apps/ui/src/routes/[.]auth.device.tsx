import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import type { FormEvent } from "react"
import { useMemo, useState } from "react"
import { Button } from "@/components/ui/Button"
import { Spinner } from "@/components/ui/spinner"
import { authClient, useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/.auth/device")({
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

function DeviceAuthorizationPage() {
  const { data: session, isPending: sessionPending } = useSession()
  const searchParams = useMemo(
    () =>
      typeof window === "undefined"
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search),
    [],
  )
  const initialCode = normalizeUserCode(searchParams.get("user_code") ?? "")
  const hasPrefilledCode = initialCode.length > 0
  const [submittedCode, setSubmittedCode] = useState(initialCode)
  const [inputCode, setInputCode] = useState(initialCode)

  const currentPath =
    typeof window === "undefined"
      ? "/.auth/device"
      : `${window.location.pathname}${window.location.search}`
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

  const submitCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextCode = normalizeUserCode(inputCode)
    if (!nextCode) return
    setSubmittedCode(nextCode)
  }

  const mutationError = approveMutation.error ?? denyMutation.error
  const isSubmitting = approveMutation.isPending || denyMutation.isPending

  return (
    <main className="hero-gradient min-h-screen bg-zinc-950 text-foreground">
      <div className="mx-auto flex min-h-screen max-w-md items-center px-6 py-16">
        <div className="relative mx-auto w-full max-w-sm">
          <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2">
            <img
              src="/ctx_.svg"
              alt="ctxpipe"
              className="h-16 w-16 select-none"
              draggable={false}
            />
          </div>
          <section className="ctx-border ctx-surface px-6 pt-24 pb-6 shadow-none">
            <div className="space-y-2 text-center">
              <h1 className="text-lg font-semibold text-zinc-100">
                Authorize ctxpipe CLI
              </h1>
              <p className="text-sm text-zinc-400">
                Approve this request to let the CLI load your organizations for
                setup.
              </p>
            </div>

            {hasPrefilledCode ? null : (
              <form onSubmit={submitCode} className="mt-6 grid gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-zinc-300">Device code</span>
                  <input
                    value={inputCode}
                    onChange={(event) => setInputCode(event.target.value)}
                    placeholder="ABCD-1234"
                    className="h-10 w-full rounded-none border border-border bg-zinc-950 px-3 font-mono text-zinc-100"
                  />
                </label>
                <Button
                  type="submit"
                  variant="secondary"
                  className="rounded-none"
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
                {hasPrefilledCode ? null : (
                  <div className="rounded-none border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
                    <p className="text-zinc-400">Request code</p>
                    <p className="font-mono text-zinc-100">{submittedCode}</p>
                  </div>
                )}

                {sessionPending ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-zinc-400">
                    <Spinner className="h-4 w-4" />
                    Checking sign-in...
                  </div>
                ) : session ? (
                  approveMutation.isSuccess ? (
                    <p className="text-sm text-teal-400">
                      Approved. Return to your terminal to continue setup.
                    </p>
                  ) : denyMutation.isSuccess ? (
                    <p className="text-sm text-zinc-400">
                      Denied. You can close this tab.
                    </p>
                  ) : (
                    <div className="flex gap-3">
                      <Button
                        type="button"
                        variant="secondary"
                        className="flex-1 rounded-none"
                        onPress={() => denyMutation.mutate()}
                        isDisabled={isSubmitting}
                      >
                        {denyMutation.isPending ? "Denying..." : "Deny"}
                      </Button>
                      <Button
                        type="button"
                        className="flex-1 rounded-none"
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
                    className="inline-flex h-9 items-center justify-center rounded-none bg-zinc-100 px-3.5 text-sm font-medium text-zinc-950 hover:bg-zinc-200"
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
