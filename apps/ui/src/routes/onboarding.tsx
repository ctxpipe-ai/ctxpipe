import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { OnboardingAgentStep } from "@/components/onboarding/OnboardingAgentStep"
import { OnboardingDiagram } from "@/components/onboarding/OnboardingDiagram"
import { OnboardingGithubStep } from "@/components/onboarding/OnboardingGithubStep"
import { OnboardingIndexingStatus } from "@/components/onboarding/OnboardingIndexingStatus"
import { OnboardingOrgStep } from "@/components/onboarding/OnboardingOrgStep"
import {
  OnboardingStep,
  StepActions,
} from "@/components/onboarding/OnboardingStep"
import {
  deriveOnboardingView,
  type OnboardingStepId,
  orgNameFromEmail,
  reopenAs,
  slugify,
  stepBefore,
  titleAction,
} from "@/components/onboarding/onboarding-state"
import { Button } from "@/components/ui/Button"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { useRepositoryIndexingSummary } from "@/features/repositories"
import {
  formatIndexingStepLabel,
  getRepositoryIndexingStatus,
} from "@/features/repositories/types"
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
  // Their work email's domain names the organisation to start with; the
  // slug follows once the session is known, and they can change both.
  const suggestedOrgName = orgNameFromEmail(session?.user.email)
  const [slugSeeded, setSlugSeeded] = useState(false)
  if (!slugSeeded && session) {
    setSlugSeeded(true)
    if (suggestedOrgName && !typedSlug) setTypedSlug(slugify(suggestedOrgName))
  }
  // What was just queued, so the picture fills before indexing rows exist.
  const [queuedRepositories, setQueuedRepositories] = useState<string[] | null>(
    null,
  )
  const [completing, setCompleting] = useState(false)
  // Going back: a done step reopens to review or change it. Beats still come
  // from the account, so reopening never undoes anything.
  const [reviewing, setReviewing] = useState<OnboardingStepId | null>(null)
  const orgSlug = urlOrgSlug ?? createdOrgSlug

  // "I'll do this later" and Continue are choices, not account state. They
  // are kept per user and org in this browser, so coming back does not
  // reopen what they set aside. Continue matters because indexing starts
  // on its own and the GitHub step stays open for the context repository.
  const choicesKey =
    session?.user && orgSlug
      ? `ctxpipe:onboarding:${session.user.id}:${orgSlug}`
      : null
  const [choices, setChoices] = useState<OnboardingChoices>(NO_CHOICES)
  const [choicesFor, setChoicesFor] = useState<string | null>(null)
  if (choicesKey !== choicesFor) {
    setChoicesFor(choicesKey)
    setChoices(readChoices(choicesKey))
  }
  const choose = (patch: Partial<OnboardingChoices>) => {
    const next = { ...choices, ...patch }
    setChoices(next)
    writeChoices(choicesKey, next)
  }
  const githubSkipped = choices.githubSkipped
  const agentSkipped = choices.agentSkipped
  const sourceContinued = choices.sourceContinued

  // Joiner or admin is decided once. No org yet: they are creating one.
  // Otherwise by role in the org: an owner coming back mid-setup is not a
  // joiner, and only owners and admins can set up GitHub.
  const arrivalOrgSlug =
    urlOrgSlug ?? (organizations?.[0]?.slug as string | undefined) ?? null
  const memberRole = useQuery({
    queryKey: ["active-member-role", arrivalOrgSlug],
    queryFn: async () => {
      const { data } = await authClient.organization.getActiveMemberRole({
        query: { organizationSlug: arrivalOrgSlug ?? "" },
      })
      return data?.role ?? null
    },
    enabled: Boolean(session && arrivalOrgSlug && createdOrgSlug === null),
  })
  // Locked on the first org list. Creating an org here makes Better Auth
  // refetch the list, which can land before the page records the new org;
  // anything that re-reads the list meanwhile must not act on it.
  const [arrivedWithOrgs, setArrivedWithOrgs] = useState<boolean | null>(null)
  if (arrivedWithOrgs === null && !orgsPending && organizations != null) {
    setArrivedWithOrgs(organizations.length > 0)
  }
  const [isJoiner, setIsJoiner] = useState<boolean | null>(null)
  if (isJoiner === null && !orgsPending && organizations != null) {
    if (organizations.length === 0) setIsJoiner(false)
    else if (memberRole.isSuccess) {
      setIsJoiner(!(memberRole.data === "owner" || memberRole.data === "admin"))
    } else if (memberRole.isError) setIsJoiner(true)
  }

  const installationQuery = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug ?? ""),
    queryFn: () =>
      orgSlug ? fetchGithubInstallationSummary(orgSlug) : Promise.resolve(null),
    enabled: Boolean(orgSlug && session),
  })
  const installation = installationQuery.data
  const setupQuery = useQuery({
    queryKey: ["github-installation-setup", orgSlug],
    queryFn: async () => {
      if (!orgSlug) throw new Error("Missing organisation")
      const res = await fetch(`/${orgSlug}/api/v1/github/installation/setup`, {
        credentials: "include",
      })
      if (!res.ok) throw new Error("Failed to fetch GitHub setup data")
      return (await res.json()) as { contextRepository?: string | null }
    },
    enabled: Boolean(orgSlug && session && installation),
  })
  // Decided once on arrival: GitHub counts as done only if they come back
  // with a context repository already set. In this visit only Continue
  // finishes the step, even when indexing or the sync binds one meanwhile.
  const [sourceDoneOnArrival, setSourceDoneOnArrival] = useState<
    boolean | null
  >(null)
  if (sourceDoneOnArrival === null) {
    if (createdOrgSlug !== null) setSourceDoneOnArrival(false)
    else if (installationQuery.isSuccess && !installationQuery.data) {
      setSourceDoneOnArrival(false)
    } else if (installationQuery.isError || setupQuery.isError) {
      setSourceDoneOnArrival(false)
    } else if (setupQuery.isSuccess) {
      setSourceDoneOnArrival(Boolean(setupQuery.data.contextRepository))
    }
  }
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
  // Perception shows real ingestion: running first, then queued, then done.
  const statusOrder = { running: 0, queued: 1, failed: 2 } as Record<
    string,
    number
  >
  const repositoryProgress =
    repositories.length > 0
      ? repositories
          .map((repo) => {
            const status = getRepositoryIndexingStatus(repo)
            return {
              name: repo.name,
              order: statusOrder[status] ?? 3,
              label:
                formatIndexingStepLabel(repo) ??
                (status === "ready"
                  ? "indexed"
                  : status === "complete_with_issues"
                    ? "with issues"
                    : status),
              fraction:
                repo.indexingStep != null && repo.indexingStepTotal
                  ? repo.indexingStep / repo.indexingStepTotal
                  : status === "ready"
                    ? 1
                    : null,
            }
          })
          .sort((a, b) => a.order - b.order)
      : (queuedRepositories ?? []).map((name) => ({
          name,
          order: 1,
          label: "queued",
          fraction: null,
        }))
  const { activeCount, failedCount, singleActiveStepLabel } =
    repositoryIndexing.summary
  const view = deriveOnboardingView({
    orgSlug,
    typedSlug,
    isJoiner: isJoiner === true,
    github: {
      installed: Boolean(installation),
      skipped: githubSkipped,
      repositories: repositoryNames,
      queued: queuedRepositories !== null,
      continued: sourceContinued || sourceDoneOnArrival === true,
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
  const arrivingWithOrg = orgSlug !== null && createdOrgSlug === null
  if (
    isJoiner === null ||
    (isPending && !session) ||
    (arrivingWithOrg && sourceDoneOnArrival === null)
  ) {
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

  // Only for people who arrived with an org, before the steps show. Someone
  // creating their org here never needs it: the refetched list can arrive
  // before createdOrgSlug is set, and rendering Navigate then unmounted the
  // whole page and replayed its fade-in (the old create-org slide skipped
  // this for the same reason).
  if (
    arrivedWithOrgs === true &&
    createdOrgSlug === null &&
    organizations &&
    organizations.length > 0
  ) {
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

  // Once every step is done or skipped, step 3 stays open: its primary is
  // Open ctx|, in the same place as every other step's primary.
  const restingStep = view.current ?? "agent"
  const openStep = reviewing ?? restingStep
  // Finishing is offered once nothing before step 3 is still to do.
  const canFinish = view.current === null || view.current === "agent"
  const nav = {
    open: openStep,
    current: restingStep,
    beats: view.beats,
    isJoiner: isJoiner === true,
  }
  // Reopening never undoes anything: a done step shows again, a skipped one
  // is un-skipped so it becomes current.
  const reopen = (id: OnboardingStepId) => {
    if (reopenAs(id, nav) === "unskip") {
      if (id === "source") choose({ githubSkipped: false })
      if (id === "agent") choose({ agentSkipped: false })
      setReviewing(null)
      return
    }
    setReviewing(id === restingStep ? null : id)
  }
  const goBackFrom = (id: "source" | "agent") => reopen(stepBefore(id, nav))
  const toggle = (id: OnboardingStepId) => {
    const action = titleAction(id, nav)
    if (action === "open") return () => reopen(id)
    if (action === "close" || action === "return") {
      return () => setReviewing(null)
    }
    return undefined
  }

  const repoWord = (n: number) =>
    `${n} ${n === 1 ? "repository" : "repositories"}`
  const skipNote =
    view.beats.source === "skipped"
      ? "GitHub is not connected. Your agent has nothing to answer from until it is."
      : null

  return (
    <OnboardingFrame
      completing={completing}
      status={
        <OnboardingIndexingStatus
          orgSlug={orgSlug}
          repositories={repositories}
          starting={queuedRepositories !== null}
        />
      }
    >
      {/* The wizard and the picture keep one height (the window, capped), so
          opening a step never resizes the page. */}
      <div className="onb-in-1 grid gap-16 lg:h-[min(52rem,calc(100dvh-9rem))] lg:min-h-144 lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
        <section
          aria-labelledby="onboarding-title"
          className="flex min-h-0 flex-col"
        >
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
          <ol className="m-0 mt-8 flex min-h-0 flex-1 list-none flex-col border-t border-white/5 p-0">
            <OnboardingStep
              number={1}
              title={
                isJoiner ? "Join your organisation" : "Create your organisation"
              }
              beat={view.beats.org}
              open={openStep === "org"}
              onSelect={toggle("org")}
              summary={orgSlug ?? undefined}
            >
              {view.beats.org === "done" ? (
                <>
                  <p className="m-0 text-sm text-muted-foreground">
                    <code className="font-mono text-zinc-200">{orgSlug}</code>{" "}
                    {isJoiner
                      ? "is the organisation you joined."
                      : "is ready. You can rename it later in Organisation settings."}
                  </p>
                  <StepActions
                    primary={
                      <Button
                        variant="primary"
                        className="rounded-none"
                        onPress={() => setReviewing(null)}
                      >
                        Continue
                      </Button>
                    }
                  />
                </>
              ) : (
                <OnboardingOrgStep
                  slug={typedSlug}
                  onSlugChange={setTypedSlug}
                  defaultName={suggestedOrgName}
                  // State only, no router navigation: navigating here was the
                  // one step change that could flash in production. A reload
                  // without ?orgSlug is sent to their org by the check above.
                  onCreated={setCreatedOrgSlug}
                />
              )}
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
                      ? "Set up by an admin"
                      : undefined
              }
              onSelect={toggle("source")}
            >
              {orgSlug ? (
                <OnboardingGithubStep
                  orgSlug={orgSlug}
                  hasInstallation={Boolean(installation)}
                  alreadyIndexed={repositoryNames.length > 0}
                  onRepositoriesQueued={setQueuedRepositories}
                  onContinue={() => {
                    choose({ sourceContinued: true })
                    setReviewing(null)
                  }}
                  onBack={() => goBackFrom("source")}
                  progressKey={choicesKey ? `${choicesKey}:context-repo` : null}
                  onSkip={() => {
                    choose({ githubSkipped: true })
                    setReviewing(null)
                  }}
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
              onSelect={toggle("agent")}
            >
              {orgSlug ? (
                <OnboardingAgentStep
                  orgSlug={orgSlug}
                  hasSource={view.hasSource}
                  firstRepository={repositoryNames[0] ?? null}
                  connectedClient={
                    firstCall ? (firstCall.client ?? "Your agent") : null
                  }
                  onSkip={() => {
                    choose({ agentSkipped: true })
                    setReviewing(null)
                  }}
                  onBack={() => goBackFrom("agent")}
                  finish={
                    canFinish
                      ? {
                          onFinish: () => void finish(),
                          pending: completing,
                          note: skipNote,
                        }
                      : null
                  }
                />
              ) : null}
            </OnboardingStep>
          </ol>
        </section>
        <div className="hidden min-h-0 md:block">
          <OnboardingDiagram
            view={view}
            orgSlug={orgSlug}
            graphLive={
              activeCount > 0 ||
              (queuedRepositories !== null && repositories.length === 0)
            }
            editing={view.current === null && !reviewing ? null : openStep}
            githubAccount={installation?.accountSlug ?? null}
            githubInstalled={Boolean(installation)}
            repositories={repositoryNames}
            progress={repositoryProgress}
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

type OnboardingChoices = {
  githubSkipped: boolean
  agentSkipped: boolean
  sourceContinued: boolean
}

const NO_CHOICES: OnboardingChoices = {
  githubSkipped: false,
  agentSkipped: false,
  sourceContinued: false,
}

// Storage can be missing or throw (private windows, blocked site data); the
// flow still works, it just forgets the choices.
function readChoices(key: string | null): OnboardingChoices {
  if (!key) return NO_CHOICES
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<
      Record<keyof OnboardingChoices, unknown>
    > | null
    return {
      githubSkipped: stored?.githubSkipped === true,
      agentSkipped: stored?.agentSkipped === true,
      sourceContinued: stored?.sourceContinued === true,
    }
  } catch {
    return NO_CHOICES
  }
}

function writeChoices(key: string | null, choices: OnboardingChoices) {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(choices))
  } catch {
    // Not remembered; nothing else depends on it.
  }
}
