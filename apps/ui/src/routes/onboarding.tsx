import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { AnimatedBackground } from "@/components/AnimatedBackground"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { client } from "@/lib/api"
import {
  authClient,
  useListOrganizations,
  useSession,
} from "@/lib/auth-client"
import {
  GITHUB_POPUP_NAME,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  setGithubSetupOrgHint,
  useWatchPopupClose,
} from "@/lib/popup"
import { useGetGithubAppInstallUrl } from "@/lib/useGetGithubAppInstallUrl"

export const Route = createFileRoute("/onboarding")({
  ssr: false,
  component: OnboardingPage,
  validateSearch: (search: Record<string, unknown>) => ({
    orgSlug: typeof search.orgSlug === "string" ? search.orgSlug : undefined,
  }),
})

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
}

function randomSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  return Array.from(bytes, (b) => chars[b % chars.length]).join("")
}

const ADMIN_SLIDES = [
  "welcome",
  "overview",
  "create-org",
  "mcp-config",
  "github",
  "invite",
] as const
const JOINER_SLIDES = ["welcome", "overview", "done"] as const
const GITHUB_FINALISING_MIN_MS = 1800

function OnboardingPage() {
  const router = useRouter()
  const search = Route.useSearch()
  const queryClient = useQueryClient()
  const { data: session, isPending } = useSession()
  const { data: organizations, isPending: orgsPending } =
    useListOrganizations()
  const githubAppInstallUrl = useGetGithubAppInstallUrl()
  const watchPopupClose = useWatchPopupClose()

  const [sceneFailed, setSceneFailed] = useState(false)
  const [typedCount, setTypedCount] = useState(0)
  const [showDetails, setShowDetails] = useState(false)
  const [currentSlide, setCurrentSlide] = useState(0)
  const [slideKey, setSlideKey] = useState(0)
  const [transitioning, setTransitioning] = useState(false)
  const [completing, setCompleting] = useState(false)

  const [orgName, setOrgName] = useState("")
  const [orgError, setOrgError] = useState<string | null>(null)
  const [createdOrgSlug, setCreatedOrgSlug] = useState<string | null>(null)
  const [mcpCopyState, setMcpCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  )

  const [inviteEmails, setInviteEmails] = useState("")
  const [inviteSent, setInviteSent] = useState(false)
  const [inviteSubmitting, setInviteSubmitting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [confirmExternalOpen, setConfirmExternalOpen] = useState(false)
  const [pendingExternalRecipients, setPendingExternalRecipients] = useState<
    string[]
  >([])
  const [isGithubSyncing, setIsGithubSyncing] = useState(false)
  const [githubSetupError, setGithubSetupError] = useState<string | null>(null)
  const [githubConnectedOptimistic, setGithubConnectedOptimistic] = useState(false)

  const transitionTimerRef = useRef<number | null>(null)
  const handleSceneLoad = useCallback(() => setSceneFailed(false), [])
  const handleSceneError = useCallback(() => setSceneFailed(true), [])

  const hadOrgAtStart = useRef<boolean | null>(null)
  if (hadOrgAtStart.current === null && !orgsPending && organizations != null) {
    hadOrgAtStart.current = organizations.length > 0
  }
  const urlOrgSlug = search.orgSlug ?? null
  const orgSlug = urlOrgSlug ?? createdOrgSlug
  const mcpSnippetOrgSlug = orgSlug ?? "your-org"
  const mcpSnippet = `{
  "mcpServers": {
    "ctxpipe": {
      "url": "https://app.ctxpipe.ai/mcp?orgSlug=${mcpSnippetOrgSlug}"
    }
  }
}`

  useEffect(() => {
    if (!organizations || organizations.length === 0) return
    const hasUrlOrgSlug = urlOrgSlug !== null
    const urlOrgIsKnown = hasUrlOrgSlug
      ? organizations.some((org: { slug: string }) => org.slug === urlOrgSlug)
      : false
    const fallbackOrgSlug = createdOrgSlug ?? organizations[0]?.slug ?? null

    if (hasUrlOrgSlug && urlOrgIsKnown) return
    if (!fallbackOrgSlug) return
    if (urlOrgSlug === fallbackOrgSlug) return

    void router.navigate({
      to: "/onboarding",
      search: (prev) => ({ ...prev, orgSlug: fallbackOrgSlug }),
      replace: true,
    })
  }, [createdOrgSlug, organizations, router, urlOrgSlug])

  useEffect(() => {
    setMcpCopyState("idle")
  }, [mcpSnippetOrgSlug])
  const isJoiner = hadOrgAtStart.current === true
  const slides = isJoiner ? JOINER_SLIDES : ADMIN_SLIDES

  const { data: installation, isPending: installationPending } = useQuery({
    queryKey: ["github-installation", orgSlug],
    queryFn: async () => {
      if (!orgSlug) return null
      const res = await client[":orgSlug"].api.v1.github.installation.$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Failed to check GitHub installation")
      return res.json()
    },
    enabled: !!orgSlug && !!session,
  })

  useEffect(() => {
    if (!installation) return
    setGithubConnectedOptimistic(true)
  }, [installation])

  const hasGithubInstallation = Boolean(installation) || githubConnectedOptimistic

  useEffect(() => {
    const target = "ctx|"
    let index = 0
    const typeTimer = window.setInterval(() => {
      index += 1
      setTypedCount(index)
      if (index >= target.length) {
        window.clearInterval(typeTimer)
        window.setTimeout(() => setShowDetails(true), 220)
      }
    }, 220)
    return () => window.clearInterval(typeTimer)
  }, [])

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current)
      }
    }
  }, [])

  if (isPending || orgsPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const user = session.user as { id: string; onboardingCompletedAt?: string | null; email?: string }
  if (user.onboardingCompletedAt && orgSlug) {
    return (
      <Navigate to="/$orgSlug" params={{ orgSlug }} replace />
    )
  }

  const goToSlide = (next: number) => {
    if (next === currentSlide || transitioning || next < 0 || next >= slides.length) return
    setTransitioning(true)
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current)
    }
    transitionTimerRef.current = window.setTimeout(() => {
      setCurrentSlide(next)
      setSlideKey((k) => k + 1)
      window.requestAnimationFrame(() => setTransitioning(false))
      transitionTimerRef.current = null
    }, 180)
  }

  const handleCreateOrg = async () => {
    const trimmed = orgName.trim()
    if (!trimmed) {
      setOrgError("Enter a name for your organisation.")
      return
    }
    setOrgError(null)
    const base = slugify(trimmed)
    const slug = base ? `${base}-${randomSuffix()}` : randomSuffix()
    try {
      const result = await authClient.organization.create({ name: trimmed, slug })
      if (result.error) throw new Error(result.error.message ?? "Failed to create organisation")
      if (result.data?.slug) {
        setCreatedOrgSlug(result.data.slug)
        void router.navigate({
          to: "/onboarding",
          search: (prev) => ({ ...prev, orgSlug: result.data.slug }),
          replace: true,
        })
        goToSlide(3)
      }
    } catch (err) {
      setOrgError(err instanceof Error ? err.message : "Failed to create organisation")
    }
  }

  const handleConnectGitHub = () => {
    if (installationPending || !orgSlug || isGithubSyncing) return
    setGithubSetupError(null)
    setGithubSetupOrgHint(orgSlug)
    const popup = openCenteredPopup(githubAppInstallUrl, {
      name: GITHUB_POPUP_NAME,
      width: 1120,
      height: 780,
    })
    if (popup) {
      watchPopupClose(popup, () => {
        void (async () => {
          setIsGithubSyncing(true)
          const startedAt = Date.now()
          const result = await handleGithubSetupPopupResult(orgSlug, queryClient)
          const elapsed = Date.now() - startedAt
          if (elapsed < GITHUB_FINALISING_MIN_MS) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, GITHUB_FINALISING_MIN_MS - elapsed),
            )
          }
          if (result.status === "registered") {
            setGithubConnectedOptimistic(true)
          } else if (result.status === "registration_failed") {
            setGithubSetupError(
              "Could not complete GitHub connection. Please try again.",
            )
          }
          setIsGithubSyncing(false)
        })()
      })
    }
  }

  const handleCopyMcpSnippet = async () => {
    try {
      await navigator.clipboard.writeText(mcpSnippet)
      setMcpCopyState("copied")
    } catch {
      setMcpCopyState("error")
    }
  }

  const parseInviteEmails = (value: string) =>
    value
      .split(/[\s,]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))

  const emailDomain = (email: string) => {
    const [, domain] = email.split("@")
    return domain?.toLowerCase() ?? ""
  }

  const sendInvites = async () => {
    setInviteError(null)
    setInviteSubmitting(true)
    const recipients = parseInviteEmails(inviteEmails)
    try {
      for (const email of recipients) {
        await authClient.organization.inviteMember({
          email,
          role: "member",
          organizationId: undefined as unknown as string,
        })
      }
      setInviteSent(true)
    } catch {
      setInviteError("Failed to send invites. Please try again.")
    } finally {
      setInviteSubmitting(false)
    }
  }

  const handleSendInvites = async () => {
    if (inviteSubmitting || inviteSent) return
    const recipients = parseInviteEmails(inviteEmails)
    if (recipients.length === 0) {
      setInviteError("Add at least one valid email address.")
      return
    }
    const inviterDomain = emailDomain(user.email ?? "")
    const externalRecipients = inviterDomain
      ? recipients.filter((email) => emailDomain(email) !== inviterDomain)
      : []
    if (externalRecipients.length > 0) {
      setPendingExternalRecipients(externalRecipients)
      setConfirmExternalOpen(true)
      return
    }
    await sendInvites()
  }

  const fadeOutAndNavigate = (url: string) => {
    setCompleting(true)
    window.setTimeout(() => {
      sessionStorage.setItem("ctxpipe:app-shell-fade-in", "1")
      window.location.replace(url)
    }, 500)
  }

  const completeOnboarding = async () => {
    if (!orgSlug || completing) return
    setCompleting(true)
    try {
      await Promise.all([
        fetch("/api/v1/onboarding/user/complete", {
          method: "POST",
          credentials: "include",
        }),
        client[":orgSlug"].api.v1.onboarding.complete.$post({
          param: { orgSlug },
        }),
      ])
    } catch {
      // best-effort
    }
    fadeOutAndNavigate(`/${orgSlug}`)
  }

  const completeJoinerOnboarding = async () => {
    if (completing) return
    setCompleting(true)
    try {
      await fetch("/api/v1/onboarding/user/complete", {
        method: "POST",
        credentials: "include",
      })
    } catch {
      // best-effort
    }
    fadeOutAndNavigate(orgSlug ? `/${orgSlug}` : "/")
  }

  const currentSlideName = slides[currentSlide]

  return (
    <main className={`relative min-h-screen overflow-hidden bg-zinc-950 text-foreground transition-opacity duration-500 ${completing ? "opacity-0" : "opacity-100"}`}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_20%_-10%,rgba(255,255,255,0.05),transparent_45%),radial-gradient(circle_at_90%_110%,rgba(255,255,255,0.03),transparent_40%)]"
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        <AnimatedBackground
          filePath="/animations/onboarding/welcome-background.v1.json"
          fps={60}
          scale={1}
          dpi={1.5}
          lazyLoad={false}
          fixed
          production={false}
          className="h-full w-full"
          style={{ width: "100%", height: "100%" }}
          onLoad={handleSceneLoad}
          onError={handleSceneError}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 pb-24 pt-16 text-center">
        <section className="w-full max-w-3xl">
          <div
            className={`mx-auto max-w-3xl transition-opacity duration-200 ${
              transitioning ? "pointer-events-none opacity-0" : "opacity-100"
            }`}
          >
            <div key={`slide-${currentSlide}-${slideKey}`}>

              {/* ── Slide: Welcome ── */}
              {currentSlideName === "welcome" && (
                <>
                  <h1
                    className="onb-in-1 mb-6 text-6xl text-zinc-100 sm:text-7xl"
                    style={{ fontFamily: "var(--font-geist-pixel-square)" }}
                  >
                    {"ctx|"
                      .slice(0, typedCount)
                      .split("")
                      .map((char, index) => (
                        <span
                          key={`${char}-${index}`}
                          className={char === "|" ? "text-teal-400" : ""}
                        >
                          {char}
                        </span>
                      ))}
                  </h1>
                  <p
                    className={`onb-in-2 mx-auto max-w-2xl text-balance text-zinc-300 transition-opacity duration-700 ${
                      showDetails ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    ctx| is the self-learning context layer for autonomous AI
                    agent fleets for engineering orgs, and their humans, too.
                  </p>
                  <div
                    className={`onb-in-3 mt-8 transition-all duration-700 ${
                      showDetails
                        ? "translate-y-0 opacity-100"
                        : "pointer-events-none translate-y-2 opacity-0"
                    }`}
                  >
                    <button
                      type="button"
                      className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
                      onClick={() => goToSlide(1)}
                    >
                      Get started
                    </button>
                  </div>
                </>
              )}

              {/* ── Slide: Overview ── */}
              {currentSlideName === "overview" && (
                <>
                  <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
                    Your engineering context layer in one place
                  </h2>
                  <div className="onb-in-2 mb-6">
                    <div className="mx-auto mb-6 max-w-3xl">
                      <img
                        src="/images/ctxpipe-onboarding-diagram.svg"
                        alt="ctxpipe onboarding diagram"
                        className="relative left-1/2 block h-auto w-[160%] max-w-none -translate-x-1/2"
                        loading="eager"
                      />
                    </div>
                    <p className="mx-auto mb-14 max-w-3xl text-balance text-zinc-300">
                      All your engineering-focused institutional knowledge
                      provided through a single intelligent, natural-language-based
                      MCP. Connect Git, your engineering tools, then let
                      your agents run to incrementally improve your knowledge
                      system over time.
                    </p>
                  </div>
                  <div className="onb-in-3">
                    <button
                      type="button"
                      className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
                      onClick={() => goToSlide(2)}
                    >
                      Next
                    </button>
                  </div>
                </>
              )}

              {/* ── Slide: Create Org (admin only) ── */}
              {currentSlideName === "create-org" && (
                <>
                  <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
                    Create your organisation
                  </h2>
                  <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
                    <p className="mx-auto mb-6 text-zinc-300">
                      Set up your organisation to start building your context
                      layer. Your team will join here.
                    </p>
                    <div className="mx-auto max-w-md rounded-none border border-border bg-zinc-950/70 p-6 text-left">
                      <label className="mb-2 block text-sm text-zinc-200">
                        Organisation name
                      </label>
                      <input
                        type="text"
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleCreateOrg()
                        }}
                        placeholder="Acme Engineering"
                        className="mb-4 h-11 w-full rounded-none border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60"
                        autoFocus
                      />
                      {orgError && (
                        <p className="mb-4 text-xs text-red-400">{orgError}</p>
                      )}
                      <div className="flex justify-end">
                        <button
                          type="button"
                          className="inline-flex h-10 items-center justify-center rounded-none border border-border bg-zinc-100 px-5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50"
                          onClick={() => void handleCreateOrg()}
                        >
                          Create organisation
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* ── Slide: Connect GitHub (admin only) ── */}
              {currentSlideName === "mcp-config" && (
                <>
                  <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
                    Add ctx| to your MCP client
                  </h2>
                  <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
                    <p className="mx-auto mb-6 max-w-2xl text-balance text-zinc-300">
                      Use this MCP config snippet in Cursor, Claude Code, or
                      any compatible client. It already includes your
                      organisation slug.
                    </p>
                    <div className="mx-auto max-w-3xl rounded-none border border-border bg-zinc-950/70 p-4 text-left">
                      <pre className="overflow-x-auto text-sm leading-6 text-zinc-100">
                        <code>{mcpSnippet}</code>
                      </pre>
                    </div>
                    <div className="mt-6 flex flex-col items-center gap-8">
                      <button
                        type="button"
                        className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
                        onClick={() => void handleCopyMcpSnippet()}
                      >
                        {mcpCopyState === "copied"
                          ? "Copied"
                          : mcpCopyState === "error"
                            ? "Copy failed"
                            : "Copy JSON"}
                      </button>
                      <button
                        type="button"
                        className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                        onClick={() => goToSlide(currentSlide + 1)}
                      >
                        Continue
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* ── Slide: Connect GitHub (admin only) ── */}
              {currentSlideName === "github" && (
                <>
                  <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
                    Connect GitHub
                  </h2>
                  <div className="onb-in-2 mx-auto mb-14 flex min-h-[280px] max-w-3xl flex-col">
                    <p className="mx-auto mb-3 text-balance text-zinc-300">
                      {isGithubSyncing
                        ? "Finalising your GitHub connection..."
                        : hasGithubInstallation
                          ? "GitHub is connected. Continue onboarding, or manage repository selection."
                          : "Connect your GitHub App to choose the organisation and repositories ctx| can index."}
                    </p>
                    <p className="mx-auto min-h-5 text-xs text-zinc-400">
                      {githubSetupError ? githubSetupError : "\u00A0"}
                    </p>
                    <div className="mt-auto flex flex-col items-center gap-8">
                      <button
                        type="button"
                        disabled={
                          installationPending ||
                          isGithubSyncing ||
                          (!orgSlug && !hasGithubInstallation)
                        }
                        className={`inline-flex h-11 items-center justify-center rounded-none border border-border px-6 text-sm font-medium transition-colors ${
                          installationPending ||
                          isGithubSyncing ||
                          (!orgSlug && !hasGithubInstallation)
                            ? "cursor-not-allowed bg-zinc-100/80 text-zinc-700"
                            : "bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
                        }`}
                        onClick={() => {
                          if (hasGithubInstallation) {
                            goToSlide(currentSlide + 1)
                            return
                          }
                          handleConnectGitHub()
                        }}
                      >
                        {isGithubSyncing
                          ? "Finalising connection..."
                          : installationPending
                            ? "Checking..."
                            : hasGithubInstallation
                              ? "Continue"
                              : "Connect GitHub"}
                      </button>
                      {hasGithubInstallation ? (
                        <button
                          type="button"
                          disabled={isGithubSyncing}
                          className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() =>
                            window.location.assign(
                              `/${orgSlug}/repositories/github/setup`,
                            )
                          }
                        >
                          Manage repositories
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isGithubSyncing}
                          className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => goToSlide(currentSlide + 1)}
                        >
                          I&apos;ll do this later
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* ── Slide: Invite Team (admin only) ── */}
              {currentSlideName === "invite" && (
                <>
                  <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
                    Invite team members
                  </h2>
                  <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
                    <p className="mx-auto mb-4 text-zinc-300">
                      ctx| is designed for your whole team and their agents. Invite
                      some co-workers to test it out with.
                    </p>
                    <div className="mx-auto max-w-3xl rounded-none border border-border bg-zinc-950/70 p-6 text-left">
                      <label className="mb-2 block text-sm text-zinc-200">
                        Email
                      </label>
                      <input
                        type="text"
                        value={inviteEmails}
                        onChange={(e) => setInviteEmails(e.target.value)}
                        placeholder="email@example.com, email2@example.com..."
                        className="mb-4 h-11 w-full rounded-none border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60"
                      />
                      {inviteError && (
                        <p className="mb-4 text-xs text-red-400">{inviteError}</p>
                      )}
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={inviteSubmitting || inviteSent}
                          className="inline-flex h-10 items-center justify-center rounded-none border border-border bg-zinc-100 px-5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
                          onClick={() => void handleSendInvites()}
                        >
                          {inviteSent ? "Invites sent" : inviteSubmitting ? "Sending invites..." : "Send invites"}
                        </button>
                      </div>
                    </div>
                    {inviteSent && (
                      <div className="mx-auto mt-4 max-w-3xl rounded-none border border-teal-400/40 bg-teal-400/10 px-4 py-3 text-sm text-teal-200">
                        Invites sent to your team
                      </div>
                    )}
                    <div className="mt-8 flex flex-col items-center gap-8">
                      {inviteSent ? (
                        <button
                          type="button"
                          disabled={completing}
                          className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50"
                          onClick={() => void completeOnboarding()}
                        >
                          {completing ? "Finishing..." : "Continue"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={completing}
                          className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                          onClick={() => void completeOnboarding()}
                        >
                          {completing ? "Finishing..." : "I\u2019ll do this later"}
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* ── Slide: Done (joiner only) ── */}
              {currentSlideName === "done" && (
                <>
                  <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
                    Welcome aboard
                  </h2>
                  <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
                    <p className="mx-auto mb-8 text-zinc-300">
                      You&apos;re all set. Your organisation is ready and waiting.
                    </p>
                  </div>
                  <div className="onb-in-3">
                    <button
                      type="button"
                      disabled={completing}
                      className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50"
                      onClick={() => void completeJoinerOnboarding()}
                    >
                      {completing ? "Finishing..." : "Get started"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Fixed dots at the bottom of the viewport */}
      <div
        className={`fixed inset-x-0 bottom-8 z-20 flex items-center justify-center gap-1.5 transition-opacity duration-700 ${
          showDetails ? "opacity-100" : "opacity-0"
        }`}
      >
        {slides.map((_, index) => (
          <button
            key={index}
            type="button"
            aria-label={`Go to slide ${index + 1}`}
            className={`h-1.5 w-1.5 rounded-full transition-all ${
              index === currentSlide
                ? "scale-110 bg-teal-400"
                : "bg-zinc-600 hover:bg-zinc-500"
            }`}
            onClick={() => goToSlide(index)}
          />
        ))}
      </div>

      {sceneFailed && (
        <p className="fixed inset-x-0 bottom-16 z-20 text-center text-xs text-zinc-500">
          Animation failed to load. Continue still works.
        </p>
      )}

      <Modal
        isOpen={confirmExternalOpen}
        onOpenChange={setConfirmExternalOpen}
        isDismissable
      >
        <Dialog role="alertdialog">
          {({ close }) => (
            <div className="rounded-none bg-zinc-950/95 p-6">
              <h2 className="mb-3 text-xl font-semibold text-zinc-100">
                Invite external users?
              </h2>
              <p className="text-zinc-300">
                Invite external users ({pendingExternalRecipients.join(", ")})?
                They will receive access to your organisations engineering
                knowledge via this app and MCP.
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <Button
                  variant="ghost"
                  className="rounded-none text-zinc-400 hover:text-zinc-200"
                  onPress={() => {
                    setPendingExternalRecipients([])
                    close()
                  }}
                >
                  Cancel
                </Button>
                <Button
                  className="rounded-none bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
                  onPress={() => {
                    void sendInvites()
                    setPendingExternalRecipients([])
                    close()
                  }}
                >
                  Send invites
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Modal>
    </main>
  )
}
