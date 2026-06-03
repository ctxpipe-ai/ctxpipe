import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useEffect, useId, useRef, useState } from "react"
import { AnimatedBackground } from "@/components/AnimatedBackground"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import { client } from "@/lib/api"
import { authClient, getSession, useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/setup")({
  component: OrgSetupPage,
})

const GITHUB_FINALISING_MIN_MS = 1800

function OrgSetupPage() {
  const router = useRouter()
  const inviteEmailsFieldId = useId()
  const { orgSlug } = Route.useParams()
  const { data: session, isPending: sessionPending } = useSession()

  const [carouselPage, setCarouselPage] = useState(0)
  const [slideKey, setSlideKey] = useState(0)
  const [carouselTransitioning, setCarouselTransitioning] = useState(false)
  const [inviteEmails, setInviteEmails] = useState("")
  const [inviteSent, setInviteSent] = useState(false)
  const [inviteSubmitting, setInviteSubmitting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [confirmExternalOpen, setConfirmExternalOpen] = useState(false)
  const [pendingExternalRecipients, setPendingExternalRecipients] = useState<
    string[]
  >([])
  const [githubSetupError, setGithubSetupError] = useState<string | null>(null)
  const [githubConnectedOptimistic, setGithubConnectedOptimistic] =
    useState(false)
  const carouselTransitionTimerRef = useRef<number | null>(null)

  const { data: installation, isPending: installationPending } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug),
    queryFn: () => fetchGithubInstallationSummary(orgSlug),
    enabled: !!session,
  })

  const {
    start,
    isPending: ghFlowPending,
    isSyncing,
    SelfHostedWizardModal,
  } = useGithubConnectFlow({
    orgSlug,
    minFinalizeAfterRegistrationMs: GITHUB_FINALISING_MIN_MS,
    onAlreadyInstalled: () => {
      void router.navigate({
        to: "/$orgSlug/repositories/github/setup",
        params: { orgSlug },
      })
    },
    onRegistered: () => {
      setGithubConnectedOptimistic(true)
      setGithubSetupError(null)
    },
    onRegistrationFailed: (msg) => setGithubSetupError(msg),
  })

  const hasGithubInstallation =
    Boolean(installation) || githubConnectedOptimistic

  const githubButtonBusy = installationPending || ghFlowPending || isSyncing

  useEffect(() => {
    return () => {
      if (carouselTransitionTimerRef.current !== null) {
        window.clearTimeout(carouselTransitionTimerRef.current)
      }
    }
  }, [])

  if (sessionPending) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100">
        <div className="flex min-h-screen items-center justify-center px-6 text-center">
          <p className="text-sm text-zinc-400">Loading setup…</p>
        </div>
      </main>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const pages = [
    { title: "Connect GitHub" },
    { title: "Invite team members" },
  ] as const

  const goToPage = (nextPage: number) => {
    if (nextPage === carouselPage || carouselTransitioning) return
    setCarouselTransitioning(true)
    if (carouselTransitionTimerRef.current !== null) {
      window.clearTimeout(carouselTransitionTimerRef.current)
    }
    carouselTransitionTimerRef.current = window.setTimeout(() => {
      setCarouselPage(nextPage)
      setSlideKey((current) => current + 1)
      window.requestAnimationFrame(() => setCarouselTransitioning(false))
      carouselTransitionTimerRef.current = null
    }, 180)
  }

  const handleConnectGitHub = () => {
    if (githubButtonBusy) return
    setGithubSetupError(null)
    start("connect")
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
    const inviterDomain = emailDomain(session.user.email ?? "")
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

  const completeSetup = async () => {
    try {
      await Promise.all([
        client[":orgSlug"].api.v1.onboarding.complete.$post({
          param: { orgSlug },
        }),
        client.api.v1.onboarding.user.complete.$post(),
      ])
      await getSession({ fetchOptions: { throw: false } })
    } catch {
      // best-effort — don't block navigation
    }
    sessionStorage.setItem("ctxpipe:app-shell-fade-in", "1")
    void router.navigate({
      to: "/$orgSlug/dashboard",
      params: { orgSlug },
      replace: true,
    })
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-zinc-950 text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_20%_-10%,rgba(255,255,255,0.05),transparent_45%),radial-gradient(circle_at_90%_110%,rgba(255,255,255,0.03),transparent_40%)]"
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        <AnimatedBackground
          filePath="/animations/onboarding/welcome-background.v1.json"
          fps={30}
          scale={0.9}
          dpi={1}
          lazyLoad
          startDelayMs={300}
          fixed
          production={false}
          className="h-full w-full"
          style={{ width: "100%", height: "100%" }}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-16 text-center">
        <section className="w-full max-w-3xl">
          <div
            className={`mx-auto max-w-3xl transition-opacity duration-200 ${
              carouselTransitioning
                ? "pointer-events-none opacity-0"
                : "opacity-100"
            }`}
          >
            <div key={`${carouselPage}-${slideKey}`}>
              <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
                {pages[carouselPage]?.title}
              </h2>

              {/* Connect GitHub slide */}
              {carouselPage === 0 && (
                <div className="onb-in-2 mx-auto mb-14 flex min-h-[280px] max-w-3xl flex-col">
                  <p className="mx-auto mb-3 text-balance text-zinc-300">
                    {isSyncing
                      ? "Finalising your GitHub connection..."
                      : hasGithubInstallation
                        ? "GitHub is connected. Continue onboarding, or adjust repository selection."
                        : "ctx| allows you to determine which repos are ingested into your knowledge system. As ctx| detects insights about your engineering processes, it will raise changes in GitHub for you to view."}
                  </p>
                  <p className="mx-auto min-h-5 text-xs text-zinc-400">
                    {githubSetupError ? githubSetupError : "\u00A0"}
                  </p>
                  <div className="mt-auto flex flex-col items-center gap-8">
                    <button
                      type="button"
                      disabled={githubButtonBusy}
                      className={`inline-flex h-11 items-center justify-center rounded-none border border-border px-6 text-sm font-medium transition-colors ${
                        githubButtonBusy
                          ? "cursor-not-allowed bg-zinc-100/80 text-zinc-700"
                          : "bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
                      }`}
                      onClick={handleConnectGitHub}
                    >
                      {isSyncing
                        ? "Finalising connection..."
                        : installationPending
                          ? "Checking..."
                          : hasGithubInstallation
                            ? "Manage GitHub App"
                            : "Connect GitHub"}
                    </button>
                    <button
                      type="button"
                      disabled={isSyncing}
                      className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => goToPage(1)}
                    >
                      I&apos;ll do this later
                    </button>
                  </div>
                </div>
              )}

              {/* Invite team slide */}
              {carouselPage === 1 && (
                <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
                  <p className="mx-auto mb-4 text-zinc-300">
                    ctx| is designed for your whole team and their agents.
                    Invite some co-workers to test it out with.
                  </p>
                  <div className="mx-auto max-w-3xl rounded-none border border-border bg-zinc-950/70 p-6 text-left">
                    <label
                      className="mb-2 block text-sm text-zinc-200"
                      htmlFor={inviteEmailsFieldId}
                    >
                      Email
                    </label>
                    <input
                      id={inviteEmailsFieldId}
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
                        onClick={handleSendInvites}
                      >
                        {inviteSent
                          ? "Invites sent"
                          : inviteSubmitting
                            ? "Sending invites..."
                            : "Send invites"}
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
                        className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
                        onClick={completeSetup}
                      >
                        Continue
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                        onClick={completeSetup}
                      >
                        I&apos;ll do this later
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Dots */}
              <div className="onb-in-3 mt-48 flex items-center justify-center gap-1.5">
                {pages.map((page, index) => (
                  <button
                    key={page.title}
                    type="button"
                    aria-label={`Go to page ${index + 1}`}
                    className={`h-1.5 w-1.5 rounded-full transition-all ${
                      index === carouselPage
                        ? "scale-110 bg-teal-400"
                        : "bg-zinc-600 hover:bg-zinc-500"
                    }`}
                    onClick={() => goToPage(index)}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>

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

      {SelfHostedWizardModal}
    </main>
  )
}
