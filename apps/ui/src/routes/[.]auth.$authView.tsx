import { AuthView } from "@daveyplate/better-auth-ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import type { FormEvent } from "react"
import { useMemo, useState } from "react"
import { betterAuthAuthViewClassNames } from "@/features/auth/betterAuthShellClassNames"
import { Button } from "@/components/ui/Button"
import { getAuthContinuationProps } from "@/lib/auth-continuation"
import { authClient, useSession } from "@/lib/auth-client"
import { useGetAuthConfig } from "@/lib/useGetAuthConfig"

export const Route = createFileRoute("/.auth/$authView")({
  ssr: false,
  component: AuthViewRoute,
})

type InvitationDetails = {
  id: string
  email: string
  status: string
  expiresAt: string
}

type InviteAcceptSignUpProps = {
  invitationId?: string
  invitationEmail?: string
  redirectTo?: string
}

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

function InviteAcceptSignUp(props: InviteAcceptSignUpProps = {}) {
  const { data: session, isPending: sessionPending } = useSession()
  const params = useMemo(
    () =>
      typeof window === "undefined"
        ? new URLSearchParams("")
        : new URLSearchParams(window.location.search),
    [],
  )
  const currentLocation =
    typeof window === "undefined"
      ? "/.auth/accept-invitation"
      : `${window.location.pathname}${window.location.search}`
  const invitationId = props.invitationId ?? (params.get("invitationId") ?? "")
  const redirectTo = props.redirectTo ?? (params.get("redirectTo") ?? "/onboarding")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)

  const invitationEmailQuery = useQuery({
    queryKey: ["public-invitation-email", invitationId],
    queryFn: async () => {
      if (props.invitationEmail) return props.invitationEmail
      const res = await fetch(
        `/.auth/api/v1/public/invitations/${encodeURIComponent(invitationId)}`,
        { credentials: "include" },
      )
      if (!res.ok) throw new Error("Invitation not found or expired")
      const json = (await res.json()) as { email: string }
      return json.email
    },
    enabled: invitationId.length > 0,
  })

  const acceptInviteMutation = useMutation({
    mutationFn: async (inviteId: string) => {
      await authClient.organization.acceptInvitation({
        invitationId: inviteId,
        fetchOptions: { throw: true },
      })
    },
  })

  const signUpMutation = useMutation({
    mutationFn: async (input: { email: string; name: string; password: string }) => {
      await authClient.signUp.email({
        email: input.email,
        password: input.password,
        name: input.name,
        callbackURL:
          currentLocation,
        fetchOptions: { throw: true },
      })
      await acceptInviteMutation.mutateAsync(invitationId)
      window.location.assign(redirectTo)
    },
    onError: (err) => setError(extractErrorMessage(err)),
  })

  if (sessionPending) return null
  if (signUpMutation.isPending || acceptInviteMutation.isPending) {
    return <p className="text-sm text-zinc-400">Setting up your account…</p>
  }
  if (session && !signUpMutation.isSuccess) {
    return (
      <AuthView
        pathname="accept-invitation"
        redirectTo={redirectTo}
        classNames={betterAuthAuthViewClassNames}
      />
    )
  }

  if (!invitationId) {
    return (
      <p className="text-sm text-red-400">
        Missing invitation ID. Please use the invitation link from your email.
      </p>
    )
  }

  if (invitationEmailQuery.isPending) {
    return <p className="text-sm text-zinc-400">Loading invitation…</p>
  }

  if (invitationEmailQuery.error || !invitationEmailQuery.data) {
    return (
      <p className="text-sm text-red-400">
        {invitationEmailQuery.error instanceof Error
          ? invitationEmailQuery.error.message
          : "Invitation not found or expired"}
      </p>
    )
  }

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError("Enter your name.")
      return
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }
    signUpMutation.mutate({
      email: invitationEmailQuery.data,
      name: name.trim(),
      password,
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <p className="text-sm text-zinc-400">
        Create your account to accept this invitation.
      </p>
      <label className="grid gap-1 text-sm">
        <span className="text-zinc-300">Email</span>
        <input
          type="email"
          value={invitationEmailQuery.data}
          disabled
          className="h-10 w-full rounded-none border border-border bg-zinc-900 px-3 text-zinc-400"
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="text-zinc-300">Name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-10 w-full rounded-none border border-border bg-zinc-950 px-3 text-zinc-100"
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="text-zinc-300">Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-10 w-full rounded-none border border-border bg-zinc-950 px-3 text-zinc-100"
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="text-zinc-300">Confirm password</span>
        <input
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          className="h-10 w-full rounded-none border border-border bg-zinc-950 px-3 text-zinc-100"
        />
      </label>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <Button
        type="submit"
        className="w-full rounded-none bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
        isDisabled={signUpMutation.isPending || acceptInviteMutation.isPending}
      >
        {signUpMutation.isPending || acceptInviteMutation.isPending
          ? "Creating account…"
          : "Create account"}
      </Button>
    </form>
  )
}

function EmailVerificationSent() {
  return (
    <main className="hero-gradient min-h-screen bg-zinc-950 text-foreground">
      <div className="mx-auto max-w-md px-6 py-16">
        <div className="relative mx-auto max-w-sm">
          <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2">
            <img
              src="/ctx_.svg"
              alt="ctxpipe"
              className="h-16 w-16 select-none"
              draggable={false}
            />
          </div>
          <div className="ctx-border ctx-surface shadow-none px-6 pt-24 pb-6 text-center">
            <h2 className="text-lg font-semibold text-teal-400">
              Email verification sent
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Check your email inbox and click the verification link to
              continue.
            </p>
            <a
              href="/.auth/sign-in"
              className="mt-4 inline-block text-sm text-teal-400 hover:text-teal-300 hover:underline"
            >
              Back to sign in
            </a>
          </div>
        </div>
      </div>
    </main>
  )
}

function AuthViewRoute() {
  const { authView } = Route.useParams()
  const { isPending: socialPending } = useGetAuthConfig()
  const continuation =
    typeof window === "undefined"
      ? undefined
      : getAuthContinuationProps(
          window.location.pathname,
          window.location.search,
        )

  const inviteFromRedirect =
    authView === "sign-up" && continuation?.redirectTo
      ? (() => {
          try {
            const inviteUrl = new URL(
              continuation.redirectTo,
              window.location.origin,
            )
            if (inviteUrl.pathname !== "/.auth/accept-invitation") return null
            const invitationId = inviteUrl.searchParams.get("invitationId")
            if (!invitationId) return null
            const inviteEmail = inviteUrl.searchParams.get("email") ?? undefined
            return {
              invitationId,
              inviteEmail,
            }
          } catch {
            return null
          }
        })()
      : null

  if (authView === "email-verification") {
    return <EmailVerificationSent />
  }
  if (authView === "accept-invitation") {
    return (
      <main className="hero-gradient min-h-screen bg-zinc-950 text-foreground">
        <div className="mx-auto max-w-md px-6 py-16">
          <div className="relative mx-auto max-w-sm">
            <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2">
              <img
                src="/ctx_.svg"
                alt="ctxpipe"
                className="h-16 w-16 select-none"
                draggable={false}
              />
            </div>
            <div className="ctx-border ctx-surface shadow-none px-6 pt-24 pb-6">
              <h2 className="mb-3 text-lg font-semibold text-zinc-100">
                Accept invitation
              </h2>
              <InviteAcceptSignUp />
            </div>
          </div>
        </div>
      </main>
    )
  }
  if (inviteFromRedirect) {
    return (
      <main className="hero-gradient min-h-screen bg-zinc-950 text-foreground">
        <div className="mx-auto max-w-md px-6 py-16">
          <div className="relative mx-auto max-w-sm">
            <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2">
              <img
                src="/ctx_.svg"
                alt="ctxpipe"
                className="h-16 w-16 select-none"
                draggable={false}
              />
            </div>
            <div className="ctx-border ctx-surface shadow-none px-6 pt-24 pb-6">
              <h2 className="mb-3 text-lg font-semibold text-zinc-100">
                Join organisation
              </h2>
              <InviteAcceptSignUp
                invitationId={inviteFromRedirect.invitationId}
                invitationEmail={inviteFromRedirect.inviteEmail}
              />
            </div>
          </div>
        </div>
      </main>
    )
  }

  const showBranding = authView === "sign-in" || authView === "sign-up"

  return (
    <main className="hero-gradient min-h-screen bg-zinc-950 text-foreground">
      <div className="mx-auto max-w-md px-6 py-16">
        <div className="relative mx-auto max-w-sm">
          {showBranding ? (
            <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2">
              <img
                src="/ctx_.svg"
                alt="ctxpipe"
                className="h-16 w-16 select-none"
                draggable={false}
              />
            </div>
          ) : null}
          {!socialPending && (
            <AuthView
              pathname={authView}
              redirectTo={continuation?.redirectTo ?? "/onboarding"}
              className={showBranding ? "pt-24" : undefined}
              classNames={betterAuthAuthViewClassNames}
            />
          )}
        </div>
      </div>
    </main>
  )
}
