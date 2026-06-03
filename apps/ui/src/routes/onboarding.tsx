import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { ADMIN_SLIDES, JOINER_SLIDES } from "@/components/onboarding/constants"
import { McpOnboardingSlide } from "@/components/onboarding/McpOnboardingSlide"
import { OnboardingCreateOrgSlide } from "@/components/onboarding/OnboardingCreateOrgSlide"
import { OnboardingGithubSlide } from "@/components/onboarding/OnboardingGithubSlide"
import { OnboardingInviteSlide } from "@/components/onboarding/OnboardingInviteSlide"
import { OnboardingJoinerDoneSlide } from "@/components/onboarding/OnboardingJoinerDoneSlide"
import { OnboardingOverviewSlide } from "@/components/onboarding/OnboardingOverviewSlide"
import { OnboardingPageShell } from "@/components/onboarding/OnboardingPageShell"
import { OnboardingWelcomeSlide } from "@/components/onboarding/OnboardingWelcomeSlide"
import { useOnboardingCarousel } from "@/components/onboarding/useOnboardingCarousel"
import {
  fetchGithubInstallationSummary,
  githubConnectorKeys,
} from "@/features/connectors/queries/github-connector"
import { client } from "@/lib/api"
import { getSession, useListOrganizations, useSession } from "@/lib/auth-client"

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
  const [createdOrgSlug, setCreatedOrgSlug] = useState<string | null>(null)
  const orgSlug = urlOrgSlug ?? createdOrgSlug

  const [isJoinerLocked, setIsJoinerLocked] = useState<boolean | null>(null)
  const [sceneFailed, setSceneFailed] = useState(false)
  const [sceneReady, setSceneReady] = useState(false)
  const [showWelcomeDotNav, setShowWelcomeDotNav] = useState(false)
  const [completing, setCompleting] = useState(false)

  useEffect(() => {
    if (sceneReady || sceneFailed) return
    const timer = window.setTimeout(() => {
      setSceneReady(true)
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [sceneReady, sceneFailed])

  useEffect(() => {
    if (orgsPending || organizations == null) return
    setIsJoinerLocked((prev) => {
      if (prev !== null) return prev
      return organizations.length > 0
    })
  }, [organizations, orgsPending])

  const slides = isJoinerLocked === true ? JOINER_SLIDES : ADMIN_SLIDES

  const { currentSlide, slideKey, transitioning, goToSlide } =
    useOnboardingCarousel(slides.length)

  const { data: installation } = useQuery({
    queryKey: githubConnectorKeys.installation(orgSlug ?? ""),
    queryFn: () =>
      orgSlug ? fetchGithubInstallationSummary(orgSlug) : Promise.resolve(null),
    enabled: Boolean(orgSlug && session),
  })
  const hasGithubInstallation = Boolean(installation)

  const onWelcomeDetailsVisible = useCallback(() => {
    setShowWelcomeDotNav(true)
  }, [])

  const mcpSnippetOrgSlug = orgSlug ?? "your-org"
  const mcpSnippet = `{
  "mcpServers": {
    "ctxpipe": {
      "type": "streamable-http",
      "url": "https://app.ctxpipe.ai/mcp?orgSlug=${mcpSnippetOrgSlug}"
    }
  }
}`

  if (isPending || orgsPending || isJoinerLocked === null) {
    return (
      <OnboardingPageShell
        completing={false}
        transitioning={false}
        showDotNav={false}
        sceneReady={false}
        currentSlide={0}
        slideCount={1}
        sceneFailed={false}
        onSceneLoad={() => {}}
        onSceneError={() => {}}
        onGoToSlide={() => {}}
      >
        <div className="onboarding-fade-in mx-auto max-w-2xl">
          <p className="text-sm text-zinc-400">Preparing onboarding…</p>
        </div>
      </OnboardingPageShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const user = session.user as {
    id: string
    onboardingCompletedAt?: string | null
    email?: string
  }
  if (user.onboardingCompletedAt && orgSlug) {
    return <Navigate to="/$orgSlug/dashboard" params={{ orgSlug }} replace />
  }

  if (organizations && organizations.length > 0) {
    const fallbackOrgSlug =
      createdOrgSlug ?? (organizations[0]?.slug as string | undefined)
    const hasUrlOrgSlug = urlOrgSlug !== null
    const urlOrgIsKnown = hasUrlOrgSlug
      ? organizations.some((org: { slug: string }) => org.slug === urlOrgSlug)
      : false
    if (
      fallbackOrgSlug &&
      (!hasUrlOrgSlug || !urlOrgIsKnown) &&
      urlOrgSlug !== fallbackOrgSlug
    ) {
      return (
        <Navigate
          to="/onboarding"
          search={{ orgSlug: fallbackOrgSlug }}
          replace
        />
      )
    }
  }

  const currentSlideName = slides[currentSlide]
  const githubSlideIndexAdmin = ADMIN_SLIDES.indexOf("github")

  const transitionToApp = (navigate: () => void) => {
    if (completing) return
    setCompleting(true)
    window.setTimeout(() => {
      sessionStorage.setItem(
        "ctxpipe:onboarding-transition-pending-at",
        String(Date.now()),
      )
      sessionStorage.setItem("ctxpipe:app-shell-fade-in", "1")
      navigate()
    }, 320)
  }

  const completeOnboarding = async () => {
    if (!orgSlug || completing) return
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
      void getSession({ fetchOptions: { throw: false } })
    } catch {
      // best-effort
    }
    transitionToApp(() => {
      void router.navigate({
        to: "/$orgSlug/dashboard",
        params: { orgSlug },
        replace: true,
      })
    })
  }

  const completeJoinerOnboarding = async () => {
    if (completing) return
    try {
      await fetch("/api/v1/onboarding/user/complete", {
        method: "POST",
        credentials: "include",
      })
      void getSession({ fetchOptions: { throw: false } })
    } catch {
      // best-effort
    }
    transitionToApp(() => {
      if (orgSlug) {
        void router.navigate({
          to: "/$orgSlug/dashboard",
          params: { orgSlug },
          replace: true,
        })
        return
      }
      void router.navigate({
        to: "/",
        search: {
          error: undefined,
          error_description: undefined,
          pendingAccountClaim: undefined,
        },
        replace: true,
      })
    })
  }

  const showDotNav =
    isJoinerLocked === true
      ? true
      : currentSlideName !== "welcome" || showWelcomeDotNav

  return (
    <OnboardingPageShell
      completing={completing}
      transitioning={transitioning}
      showDotNav={showDotNav}
      sceneReady={sceneReady}
      currentSlide={currentSlide}
      slideCount={slides.length}
      sceneFailed={sceneFailed}
      onSceneLoad={() => {
        setSceneReady(true)
        setSceneFailed(false)
      }}
      onSceneError={() => {
        setSceneReady(true)
        setSceneFailed(true)
      }}
      onGoToSlide={(i) => goToSlide(i)}
    >
      <div key={`slide-${currentSlide}-${slideKey}`}>
        {currentSlideName === "welcome" ? (
          <OnboardingWelcomeSlide
            onWelcomeDetailsVisible={onWelcomeDetailsVisible}
            onGetStarted={() => goToSlide(1)}
          />
        ) : null}

        {currentSlideName === "overview" ? (
          <OnboardingOverviewSlide onNext={() => goToSlide(2)} />
        ) : null}

        {currentSlideName === "create-org" ? (
          <OnboardingCreateOrgSlide
            onOrgCreated={(slug) => {
              setCreatedOrgSlug(slug)
              goToSlide(githubSlideIndexAdmin)
            }}
          />
        ) : null}

        {currentSlideName === "github" ? (
          <OnboardingGithubSlide
            orgSlug={orgSlug}
            onContinue={() => goToSlide(currentSlide + 1)}
          />
        ) : null}

        {currentSlideName === "mcp-config" ? (
          <McpOnboardingSlide
            key={orgSlug ?? "no-org"}
            orgSlug={orgSlug}
            hasGithubInstallation={hasGithubInstallation}
            mcpSnippet={mcpSnippet}
            onContinue={() => goToSlide(currentSlide + 1)}
            onSkip={() => goToSlide(currentSlide + 1)}
          />
        ) : null}

        {currentSlideName === "invite" ? (
          <OnboardingInviteSlide
            userEmail={user.email}
            completing={completing}
            onCompleteOnboarding={() => completeOnboarding()}
          />
        ) : null}

        {currentSlideName === "done" ? (
          <OnboardingJoinerDoneSlide
            completing={completing}
            onFinish={() => completeJoinerOnboarding()}
          />
        ) : null}
      </div>
    </OnboardingPageShell>
  )
}
