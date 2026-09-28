import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { OnboardingAgentStep } from "@/components/onboarding/OnboardingAgentStep"
import { OnboardingDiagram } from "@/components/onboarding/OnboardingDiagram"
import { OnboardingGithubStep } from "@/components/onboarding/OnboardingGithubStep"
import { OnboardingOrgStep } from "@/components/onboarding/OnboardingOrgStep"
import { OnboardingStep } from "@/components/onboarding/OnboardingStep"
import { deriveOnboardingView } from "@/components/onboarding/onboarding-state"
import { Button } from "@/components/ui/Button"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { useRepositoryIndexingSummary } from "@/features/repositories"
import { getRepositoryIndexingStatus } from "@/features/repositories/types"
import { client } from "@/lib/api"
import {
  authClient,
  getSession,
  useListOrganizations,
  useSession,
} from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

export const Route = createFileRoute("/onboarding")({
  ssr: false,
  component: OnboardingPage,
  validateSearch: (search: Record<string, unknown>) => ({
    orgSlug: typeof search.orgSlug === "string" ? search.orgSlug : undefined,
  }),
})

function OnboardingPage() {
  const search = Route.useSearch()
  return <OnboardingPageContent urlOrgSlug={search.orgSlug ?? null} />
}

export function OnboardingPageContent({
  urlOrgSlug,
}: {
  urlOrgSlug: string | null
}) {
  const { data: session, isPending } = useSession()
  const router = useRouter()
  const { data: organizations, isPending: orgsPending } = useListOrganizations()
  const [, setPreferences] = useUserPreferences()
  const [createdOrgSlug, setCreatedOrgSlug] = useState<string | null>(null)
  const [typedSlug, setTypedSlug] = useState("")
  const [githubSkipped, setGithubSkipped] = useState(false)
  const [agentSkipped, setAgentSkipped] = useState(false)
  // What was just queued, so the picture fills before indexing rows exist.
  const [queuedRepositories, setQueuedRepositories] = useState<string[] | null>(
    null,
  )
  const [completing, setCompleting] = useState(false)
  // Going back: a done step reopens to review or change it. Beats still come
  // from the account, so reopening never undoes anything.
  const [reviewing, setReviewing] = useState<"source" | "agent" | null>(null)
  const orgSlug = urlOrgSlug ?? createdOrgSlug

  // Joiner or admin is decided once, from the orgs they had on arrival, so
  // creating an org mid-flow does not flip the admin into the joiner flow.
  const [isJoiner, setIsJoiner] = useState<boolean | null>(null)
  if (isJoiner === null && !orgsPending && organizations != null) {
    setIsJoiner(organizations.length > 0)
  }

  const { data: installation } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug ?? ""),
    queryFn: () =>
      orgSlug ? fetchGithubInstallationSummary(orgSlug) : Promise.resolve(null),
    enabled: Boolean(orgSlug && session),
  })
  const repositoryIndexing = useRepositoryIndexingSummary(orgSlug, {
    enabled: Boolean(orgSlug && session),
    pollWhileEmpty: queuedRepositories !== null,
  })
  // The agent beat completes on the backend's record of this user's first
  // MCP call, so poll until it exists (or they skip the step).
  const { data: userOnboarding } = useQuery({
    queryKey: ["user-onboarding"],
    queryFn: async () => {
      const res = await fetch("/api/v1/onboarding/user", {
        credentials: "include",
      })
      if (!res.ok) throw new Error("Failed to fetch onboarding state")
      return (await res.json()) as {
        firstMcpCall: {
          at: string
          client: string | null
          tool: string | null
        } | null
      }
    },
    enabled: Boolean(orgSlug && session) && !agentSkipped,
    refetchInterval: (query) => (query.state.data?.firstMcpCall ? false : 2000),
    // They run the command in a terminal, then come back to this tab.
    refetchOnWindowFocus: "always",
  })
  const firstCall = userOnboarding?.firstMcpCall ?? null

  const repositories = repositoryIndexing.repositories ?? []
  const repositoryNames =
    repositories.length > 0
      ? repositories.map((repo) => repo.name)
      : (queuedRepositories ?? [])
  const {
    activeCount,
    failedCount,
    runningCount,
    totalCount,
    singleActiveStepLabel,
  } = repositoryIndexing.summary
  // Same pill as the old onboarding: it stays visible on every step while
  // repositories index.
  const repositoryStatus =
    activeCount > 0
      ? {
          tone: "indexing" as const,
          label: `${runningCount > 0 ? "Indexing" : "Preparing"} ${activeCount} ${
            activeCount === 1 ? "repository" : "repositories"
          }`,
        }
      : failedCount > 0
        ? {
            tone: "failed" as const,
            label: `${failedCount} ${
              failedCount === 1 ? "repository needs" : "repositories need"
            } attention`,
          }
        : queuedRepositories !== null &&
            totalCount === 0 &&
            !repositoryIndexing.isError
          ? {
              tone: "indexing" as const,
              label: "Starting repository indexing",
            }
          : null
  const view = deriveOnboardingView({
    orgSlug,
    typedSlug,
    isJoiner: isJoiner === true,
    github: {
      installed: Boolean(installation),
      skipped: githubSkipped,
      repositories: repositoryNames,
      queued: queuedRepositories !== null,
      activeCount,
      readyCount: repositories.filter(
        (repo) => getRepositoryIndexingStatus(repo) === "ready",
      ).length,
      failedCount,
      stepLabel: singleActiveStepLabel,
    },
    agent: { firstCall, skipped: agentSkipped },
  })

  // Only the first load shows this. Creating the org refetches the session
  // and org list; showing it then would unmount the picture and replay its
  // fade-in between step 1 and step 2.
  if (isJoiner === null || (isPending && !session)) {
    return (
      <OnboardingFrame completing={false}>
        <p className="text-sm text-muted-foreground">Preparing onboarding…</p>
      </OnboardingFrame>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const user = session.user as { onboardingCompletedAt?: string | null }
  if (user.onboardingCompletedAt && orgSlug) {
    return <Navigate to="/$orgSlug" params={{ orgSlug }} replace />
  }

  // Skipped once they create an org here: the page moves the URL itself, and
  // the org list can arrive before it (the old create-org slide skipped this
  // too). Redirecting in between would remount the page.
  if (createdOrgSlug === null && organizations && organizations.length > 0) {
    const fallbackOrgSlug = organizations[0]?.slug as string | undefined
    const urlOrgIsKnown =
      urlOrgSlug !== null &&
      organizations.some((org: { slug: string }) => org.slug === urlOrgSlug)
    if (fallbackOrgSlug && !urlOrgIsKnown && urlOrgSlug !== fallbackOrgSlug) {
      return (
        <Navigate
          to="/onboarding"
          search={{ orgSlug: fallbackOrgSlug }}
          replace
        />
      )
    }
  }

  const finish = async () => {
    if (!orgSlug || completing) return
    setCompleting(true)
    try {
      if (isJoiner) {
        await fetch("/api/v1/onboarding/user/complete", {
          method: "POST",
          credentials: "include",
        })
      } else {
        const organization = organizations?.find(
          (org: { slug: string }) => org.slug === orgSlug,
        )
        if (organization && typeof organization.id === "string") {
          await authClient.organization.setActive({
            organizationId: organization.id,
            fetchOptions: { throw: true },
          })
        }
        await Promise.all([
          fetch("/api/v1/onboarding/user/complete", {
            method: "POST",
            credentials: "include",
          }),
          client[":orgSlug"].api.v1.onboarding.complete.$post({
            param: { orgSlug },
          }),
        ])
        setPreferences((prev) => ({
          ...prev,
          selectedOrganizationSlug: orgSlug,
        }))
      }
      void getSession({ fetchOptions: { throw: false } })
    } catch {
      // best-effort: the app shell re-checks completion on arrival
    }
    window.setTimeout(() => {
      sessionStorage.setItem(
        "ctxpipe:onboarding-transition-pending-at",
        String(Date.now()),
      )
      sessionStorage.setItem("ctxpipe:app-shell-fade-in", "1")
      void router.navigate({
        to: "/$orgSlug",
        params: { orgSlug },
        replace: true,
      })
    }, 320)
  }

  const openStep = reviewing ?? view.current
  const stepAction = (id: "source" | "agent", onConnectNow: () => void) => {
    const beat = view.beats[id]
    if (beat === "skipped") {
      return (
        <Button
          variant="ghost"
          className="h-7 rounded-none px-2 text-xs"
          onPress={() => {
            setReviewing(null)
            onConnectNow()
          }}
        >
          Connect now
        </Button>
      )
    }
    if (beat !== "done") return null
    return (
      <Button
        variant="ghost"
        className="h-7 rounded-none px-2 text-xs"
        onPress={() => setReviewing(reviewing === id ? null : id)}
      >
        {reviewing === id ? "Close" : "Change"}
      </Button>
    )
  }

  const repoWord = (n: number) =>
    `${n} ${n === 1 ? "repository" : "repositories"}`
  const skipNote =
    view.beats.source === "skipped" && view.beats.agent === "skipped"
      ? "GitHub and the agent are skipped. Both stay dark until you connect them."
      : view.beats.source === "skipped"
        ? "GitHub is not connected. Your agent has nothing to answer from until it is."
        : view.beats.agent === "skipped"
          ? "No agent is connected yet. Add the config whenever you are ready."
          : null

  return (
    <OnboardingFrame
      completing={completing}
      status={
        repositoryStatus ? (
          <output
            aria-live="polite"
            className={`inline-flex items-center gap-2 border bg-zinc-950/90 px-3 py-2 font-mono text-xs ${
              repositoryStatus.tone === "failed"
                ? "border-red-400/30 text-red-200"
                : "border-teal-400/30 text-teal-100"
            }`}
          >
            <span
              aria-hidden
              className={
                repositoryStatus.tone === "failed"
                  ? "ctx-indexing-failed-dot"
                  : "ctx-indexing-dot"
              }
            />
            {repositoryStatus.label}
          </output>
        ) : null
      }
    >
      <div className="onb-in-1 grid gap-16 lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
        <section aria-labelledby="onboarding-title" className="flex flex-col">
          <h1
            id="onboarding-title"
            className="m-0 text-3xl font-medium tracking-tight text-zinc-100"
          >
            {isJoiner ? "Join ctx|" : "Set up ctx|"}
          </h1>
          <p className="mt-3 mb-0 max-w-prose text-sm text-muted-foreground">
            {isJoiner
              ? "Your organisation is ready. Connect your agent and the picture lights up when it first calls ctx|."
              : "Three steps. The picture lights up as each one works."}
          </p>
          <ol className="m-0 mt-8 list-none border-t border-white/5 p-0">
            <OnboardingStep
              number={1}
              title={
                isJoiner ? "Join your organisation" : "Create your organisation"
              }
              beat={view.beats.org}
              open={openStep === "org"}
              summary={orgSlug ?? undefined}
            >
              <OnboardingOrgStep
                slug={typedSlug}
                onSlugChange={setTypedSlug}
                onCreated={(slug) => {
                  setCreatedOrgSlug(slug)
                  void router.navigate({
                    to: "/onboarding",
                    search: { orgSlug: slug },
                    replace: true,
                  })
                }}
              />
            </OnboardingStep>
            <OnboardingStep
              number={2}
              title="Connect GitHub"
              beat={view.beats.source}
              open={openStep === "source"}
              summary={
                view.beats.source === "done"
                  ? repositoryNames.length > 0
                    ? `${repoWord(repositoryNames.length)}${activeCount > 0 ? ", indexing" : ""}`
                    : "indexing"
                  : view.beats.source === "skipped"
                    ? "Skipped"
                    : isJoiner
                      ? "Not connected"
                      : undefined
              }
              action={stepAction("source", () => setGithubSkipped(false))}
            >
              {orgSlug ? (
                <OnboardingGithubStep
                  key={reviewing === "source" ? "review" : "setup"}
                  orgSlug={orgSlug}
                  hasInstallation={Boolean(installation)}
                  startEditing={reviewing === "source"}
                  onRepositoriesQueued={(names) => {
                    setQueuedRepositories(names)
                    setReviewing(null)
                  }}
                  onSkip={() =>
                    reviewing === "source"
                      ? setReviewing(null)
                      : setGithubSkipped(true)
                  }
                />
              ) : null}
            </OnboardingStep>
            <OnboardingStep
              number={3}
              title="Connect an agent"
              beat={view.beats.agent}
              open={openStep === "agent"}
              summary={
                view.beats.agent === "done"
                  ? (firstCall?.client ?? "Connected")
                  : view.beats.agent === "skipped"
                    ? "Skipped"
                    : undefined
              }
              action={stepAction("agent", () => setAgentSkipped(false))}
            >
              {orgSlug ? (
                <OnboardingAgentStep
                  orgSlug={orgSlug}
                  hasSource={view.hasSource}
                  firstRepository={repositoryNames[0] ?? null}
                  connectedClient={
                    firstCall ? (firstCall.client ?? "Your agent") : null
                  }
                  onSkip={() => setAgentSkipped(true)}
                />
              ) : null}
            </OnboardingStep>
          </ol>
          {view.current === null ? (
            <div className="mt-6 flex flex-col items-start gap-3">
              {skipNote ? (
                <p className="m-0 text-sm text-muted-foreground">{skipNote}</p>
              ) : null}
              <Button
                variant="primary"
                className="rounded-none"
                isPending={completing}
                onPress={() => void finish()}
              >
                Open ctx|
              </Button>
            </div>
          ) : null}
        </section>
        <div className="hidden md:block lg:sticky lg:top-8 lg:self-start">
          <OnboardingDiagram
            view={view}
            editing={openStep}
            githubAccount={installation?.accountSlug ?? null}
            repositories={repositoryNames}
            firstCall={firstCall}
          />
        </div>
      </div>
    </OnboardingFrame>
  )
}

function OnboardingFrame({
  completing,
  status,
  children,
}: {
  completing: boolean
  status?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <main
      className={`onb-page-in hero-gradient min-h-screen bg-zinc-950 text-foreground transition-opacity duration-300 ${
        completing ? "opacity-0" : "opacity-100"
      }`}
    >
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-12 px-6 py-8 lg:px-12">
        <header className="flex items-center justify-between">
          <span className="font-mono text-xl text-zinc-100">
            ctx<span className="text-teal-400">|</span>
          </span>
          <span className="flex items-center gap-6">
            {status}
            <a
              href="/.auth/sign-out"
              className="text-sm text-muted-foreground transition-colors hover:text-teal-400"
            >
              Sign out
            </a>
          </span>
        </header>
        {children}
      </div>
    </main>
  )
}
