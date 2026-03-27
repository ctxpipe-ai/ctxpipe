import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { AnimatedBackground } from "@/components/AnimatedBackground"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { client } from "@/lib/api"
import {
  hasCompletedOnboarding,
  markHomepageFadePending,
  markOnboardingCompleted,
} from "@/lib/onboarding"
import { useSession } from "@/lib/auth-client"
import { usePreferredOrganization } from "@/lib/orgs"
import { onPopupClosed, openCenteredPopup } from "@/lib/popup"
import { useGetGithubAppInstallUrl } from "@/lib/useGetGithubAppInstallUrl"

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
})

function OnboardingPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: session, isPending } = useSession()
  const { targetOrganization } = usePreferredOrganization()
  const githubAppInstallUrl = useGetGithubAppInstallUrl()
  const [sceneFailed, setSceneFailed] = useState(false)
  const [typedCount, setTypedCount] = useState(0)
  const [showDetails, setShowDetails] = useState(false)
  const [phase, setPhase] = useState<"intro" | "carousel">("intro")
  const [introExiting, setIntroExiting] = useState(false)
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
  const carouselTransitionTimerRef = useRef<number | null>(null)
  const handleSceneLoad = useCallback(() => setSceneFailed(false), [])
  const handleSceneError = useCallback(() => setSceneFailed(true), [])
  const { data: installation, isPending: installationPending } = useQuery({
    queryKey: ["github-installation", targetOrganization?.slug],
    queryFn: async () => {
      if (!targetOrganization?.slug) return null
      const res = await client[":orgSlug"].api.v1.github.installation.$get({
        param: { orgSlug: targetOrganization.slug },
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error("Failed to check GitHub installation")
      return res.json()
    },
    enabled: !!targetOrganization?.slug,
  })

  const pages = [
    {
      title: "Your context layer in one place",
      body: "All your engineering-focused institutional knowledge provided through a single intelligent, natural-language-based MCP. Connect Git, docs, and your engineering tools, then let your agents run to incrementally improve your knowledge system over time.",
    },
    {
      title: "Connect GitHub",
      body: "ctx| allows you to determine which repos are ingested into your knowledge system. As ctx| detects insights about your engineering processes, it will raise changes in GitHub for you to view. Ingested context from knowledge tools is handled via GitHub, through PRs and merging into context repos.",
    },
    {
      title: "Invite team members",
      body: "Bring your team into the same context system so insights, reviews, and context updates happen collaboratively across the org.",
    },
  ] as const

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

    return () => {
      window.clearInterval(typeTimer)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (carouselTransitionTimerRef.current !== null) {
        window.clearTimeout(carouselTransitionTimerRef.current)
      }
    }
  }, [])

  if (isPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  if (hasCompletedOnboarding(session.user.id))
    return <Navigate to="/" replace />

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

    // MVP flow: keep user on page and show success state.
    await new Promise((resolve) => window.setTimeout(resolve, 650))

    setInviteSubmitting(false)
    setInviteSent(true)
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

  const handleConnectGitHub = () => {
    const orgSlug = targetOrganization?.slug
    if (!orgSlug) {
      toast.error("Select an organisation first, then connect GitHub.")
      return
    }

    if (installationPending) return

    if (installation) {
      void router.navigate({
        to: "/$orgSlug/repositories/github/setup",
        params: { orgSlug },
      })
      return
    }

    const popup = openCenteredPopup(githubAppInstallUrl, {
      name: "github-app-install",
      width: 1120,
      height: 780,
    })
    if (popup) {
      onPopupClosed(popup, () => {
        void queryClient.invalidateQueries({
          queryKey: ["github-installation", orgSlug],
        })
      })
    }
  }

  const completeOnboardingAndGoHome = () => {
    markOnboardingCompleted(session.user.id)
    markHomepageFadePending()
    void router.navigate({ to: "/", replace: true })
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

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-16 text-center">
        <section className="w-full max-w-3xl">
          <div
            className={`transition-opacity duration-500 ${
              phase === "intro" && !introExiting
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0"
            }`}
          >
            <h1
              className="mb-6 text-6xl text-zinc-100 sm:text-7xl"
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
              className={`mx-auto max-w-2xl text-balance text-zinc-300 transition-opacity duration-700 ${
                showDetails ? "opacity-100" : "opacity-0"
              }`}
            >
              ctx| is the self-learning context layer for autonomous AI agent
              fleets for engineering orgs, and their humans, too.
            </p>

            <button
              type="button"
              className={`mt-8 inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-all duration-700 hover:bg-zinc-200 ${
                showDetails
                  ? "translate-y-0 opacity-100"
                  : "pointer-events-none translate-y-2 opacity-0"
              }`}
              onClick={() => {
                setIntroExiting(true)
                window.setTimeout(() => setPhase("carousel"), 480)
              }}
            >
              Get started
            </button>
          </div>

          <div
            className={`transition-opacity duration-500 ${
              phase === "carousel"
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none absolute inset-0 opacity-0"
            }`}
          >
            <div
              className={`mx-auto max-w-3xl transition-opacity duration-200 ${
                carouselTransitioning
                  ? "pointer-events-none opacity-0"
                  : "opacity-100"
              }`}
            >
              <div key={`${carouselPage}-${slideKey}`}>
                <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
                  {pages[carouselPage].title}
                </h2>

                {carouselPage === 0 ? (
                  <div className="onb-in-2 mb-6">
                    <div className="mx-auto mb-6 max-w-3xl">
                      <svg
                        viewBox="0 0 1020 280"
                        className="h-auto w-full"
                        role="img"
                        aria-label="Git, Docs, and Tools flow into ctx ingestion and knowledge graph, then intelligent MCP, then agents and humans"
                      >
                        <defs>
                          <marker
                            id="flow-arrow"
                            markerWidth="6"
                            markerHeight="6"
                            refX="5"
                            refY="3"
                            orient="auto"
                            markerUnits="strokeWidth"
                          >
                            <path d="M0,0 L6,3 L0,6 z" fill="rgb(45 212 191)" />
                          </marker>
                          <marker
                            id="flow-arrow-muted"
                            markerWidth="6"
                            markerHeight="6"
                            refX="5"
                            refY="3"
                            orient="auto"
                            markerUnits="strokeWidth"
                          >
                            <path
                              d="M0,0 L6,3 L0,6 z"
                              fill="rgb(161 161 170)"
                            />
                          </marker>
                        </defs>

                        <rect
                          x="40"
                          y="40"
                          width="120"
                          height="40"
                          fill="none"
                          stroke="rgba(161,161,170,0.9)"
                        />
                        <text
                          x="100"
                          y="65"
                          textAnchor="middle"
                          fill="rgb(212 212 216)"
                          fontSize="16"
                          fontFamily="var(--font-geist-mono)"
                        >
                          Git
                        </text>

                        <rect
                          x="40"
                          y="120"
                          width="120"
                          height="40"
                          fill="none"
                          stroke="rgba(161,161,170,0.9)"
                        />
                        <text
                          x="100"
                          y="145"
                          textAnchor="middle"
                          fill="rgb(212 212 216)"
                          fontSize="16"
                          fontFamily="var(--font-geist-mono)"
                        >
                          Docs
                        </text>

                        <rect
                          x="40"
                          y="200"
                          width="120"
                          height="40"
                          fill="none"
                          stroke="rgba(161,161,170,0.9)"
                        />
                        <text
                          x="100"
                          y="225"
                          textAnchor="middle"
                          fill="rgb(212 212 216)"
                          fontSize="16"
                          fontFamily="var(--font-geist-mono)"
                        >
                          Tools
                        </text>

                        <rect
                          x="320"
                          y="112"
                          width="300"
                          height="56"
                          fill="none"
                          stroke="rgba(45,212,191,0.6)"
                        />
                        <text
                          x="470"
                          y="145"
                          textAnchor="middle"
                          fill="rgb(153 246 228)"
                          fontSize="14"
                          fontFamily="var(--font-geist-mono)"
                        >
                          ctx| ingestion + knowledge graph
                        </text>

                        <rect
                          x="660"
                          y="112"
                          width="170"
                          height="56"
                          fill="none"
                          stroke="rgba(45,212,191,0.6)"
                        />
                        <text
                          x="745"
                          y="145"
                          textAnchor="middle"
                          fill="rgb(153 246 228)"
                          fontSize="14"
                          fontFamily="var(--font-geist-mono)"
                        >
                          intelligent MCP
                        </text>

                        <rect
                          x="880"
                          y="112"
                          width="140"
                          height="56"
                          fill="none"
                          stroke="rgba(161,161,170,0.9)"
                        />
                        <text
                          x="950"
                          y="145"
                          textAnchor="middle"
                          fill="rgb(212 212 216)"
                          fontSize="14"
                          fontFamily="var(--font-geist-mono)"
                        >
                          agents &amp; humans
                        </text>

                        <path
                          d="M160 60 H230 V140"
                          stroke="rgb(161 161 170)"
                          strokeWidth="2"
                          fill="none"
                        />
                        <path
                          d="M160 140 H230"
                          stroke="rgb(161 161 170)"
                          strokeWidth="2"
                          fill="none"
                        />
                        <path
                          d="M160 220 H230 V140"
                          stroke="rgb(161 161 170)"
                          strokeWidth="2"
                          fill="none"
                        />
                        <path
                          d="M230 140 H320"
                          stroke="rgb(161 161 170)"
                          strokeWidth="2"
                          fill="none"
                          markerEnd="url(#flow-arrow-muted)"
                        />

                        <path
                          d="M620 140 H660"
                          stroke="rgb(45 212 191)"
                          strokeWidth="2"
                          fill="none"
                          markerEnd="url(#flow-arrow)"
                        />
                        <path
                          d="M830 140 H880"
                          stroke="rgb(45 212 191)"
                          strokeWidth="2"
                          fill="none"
                          markerEnd="url(#flow-arrow)"
                        />
                      </svg>
                    </div>
                  </div>
                ) : null}

                {carouselPage !== 2 ? (
                  <p className="onb-in-2 mx-auto mb-14 max-w-3xl text-balance text-zinc-300">
                    {pages[carouselPage].body}
                  </p>
                ) : (
                  <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
                    <p className="mx-auto mb-4 text-zinc-300">
                      Linear is meant to be used with your team. Invite some
                      co-workers to test it out with.
                    </p>
                    <div className="mx-auto max-w-3xl rounded-none border border-border bg-zinc-950/70 p-6 text-left">
                      <label className="mb-2 block text-sm text-zinc-200">
                        Email
                      </label>
                      <input
                        type="text"
                        value={inviteEmails}
                        onChange={(event) =>
                          setInviteEmails(event.target.value)
                        }
                        placeholder="email@example.com, email2@example.com..."
                        className="mb-4 h-11 w-full rounded-none border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60"
                      />
                      {inviteError ? (
                        <p className="mb-4 text-xs text-red-400">
                          {inviteError}
                        </p>
                      ) : null}
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
                    {inviteSent ? (
                      <div className="mx-auto mt-4 max-w-3xl rounded-none border border-teal-400/40 bg-teal-400/10 px-4 py-3 text-sm text-teal-200">
                        Invites sent to your team
                      </div>
                    ) : null}
                  </div>
                )}

                <div className="onb-in-3 flex items-center justify-center gap-4">
                  {carouselPage === 0 ? (
                    <button
                      type="button"
                      className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
                      onClick={() => goToPage(carouselPage + 1)}
                    >
                      Next
                    </button>
                  ) : carouselPage === 1 ? (
                    <div className="flex flex-col items-center gap-8">
                      <button
                        type="button"
                        disabled={installationPending}
                        className={`inline-flex h-11 items-center justify-center rounded-none border border-border px-6 text-sm font-medium transition-colors ${
                          installationPending
                            ? "cursor-not-allowed bg-zinc-100/80 text-zinc-700"
                            : "bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
                        }`}
                        onClick={handleConnectGitHub}
                      >
                        {installationPending
                          ? "Checking..."
                          : installation
                            ? "Manage GitHub App"
                            : "Connect GitHub"}
                      </button>
                      <button
                        type="button"
                        className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                        onClick={() => goToPage(2)}
                      >
                        I&apos;ll do this later
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-8">
                      {inviteSent ? (
                        <button
                          type="button"
                          className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
                          onClick={completeOnboardingAndGoHome}
                        >
                          Continue
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
                          onClick={completeOnboardingAndGoHome}
                        >
                          I&apos;ll do this later
                        </button>
                      )}
                    </div>
                  )}
                </div>

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
          </div>

          {sceneFailed ? (
            <p className="mt-4 text-xs text-zinc-500">
              Animation failed to load. Continue still works.
            </p>
          ) : null}
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
    </main>
  )
}
