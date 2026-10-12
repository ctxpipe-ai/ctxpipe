import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { ADMIN_SLIDES, JOINER_SLIDES } from "@/components/onboarding/constants"
import { OnboardingCreateOrgSlide } from "@/components/onboarding/OnboardingCreateOrgSlide"
import { OnboardingGithubSlide } from "@/components/onboarding/OnboardingGithubSlide"
import { OnboardingHowItWorksSlide } from "@/components/onboarding/OnboardingHowItWorksSlide"
import { OnboardingPageShell } from "@/components/onboarding/OnboardingPageShell"
import { OnboardingWelcomeSlide } from "@/components/onboarding/OnboardingWelcomeSlide"
import { useOnboardingCarousel } from "@/components/onboarding/useOnboardingCarousel"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import { client } from "@/lib/api"
import { apiFetch, readApiJson } from "@/lib/api-result"
import {
  authClient,
  refetchSessionOnboardingComplete,
  useListOrganizations,
  useSession,
} from "@/lib/auth-client"
import { isAdminRole, sessionUser } from "@/lib/session-user"
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

const FINISH_ERROR = "Could not finish onboarding. Try again."

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

  const { currentSlide, goToSlide } = useOnboardingCarousel(slides.length)

  const onWelcomeDetailsVisible = useCallback(() => {
    setShowWelcomeDotNav(true)
  }, [])

  // Signed out (e.g. an expired verification link landed here): the
  // organization data below never arrives, so do not wait for it.
  if (!isPending && !session) return <Navigate to="/.auth/sign-in" replace />
  if (isPending || orgsPending || isJoinerLocked === null) {
    return (
      <OnboardingPageShell
        showDotNav={false}
        sceneReady={false}
        currentSlide={0}
        slideCount={1}
        sceneFailed={false}
        onSceneLoad={() => {}}
        onSceneError={() => {}}
        onGoToSlide={() => {}}
      >
        <div className="mx-auto max-w-2xl">
          <PageBodySkeleton label="Preparing onboarding" />
        </div>
      </OnboardingPageShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const user = sessionUser(session)
  if (user?.onboardingCompletedAt && orgSlug) {
    return <Navigate to="/$orgSlug" params={{ orgSlug }} replace />
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
      slides[currentSlide] !== "create-org" &&
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

  /**
   * Finish onboarding for both paths: make the org active, mark the user
   * (and, for an owner or admin, the org) complete, then open Home.
   */
  const finish = async () => {
    if (!orgSlug || completing) return
    setCompleting(true)
    const organization = organizations?.find((org) => org.slug === orgSlug)
    try {
      if (organization) {
        await authClient.organization.setActive({
          organizationId: organization.id,
          fetchOptions: { throw: true },
        })
      }
      const { role } = await authClient.organization.getActiveMemberRole({
        query: { organizationSlug: orgSlug },
        fetchOptions: { throw: true },
      })
      await Promise.all([
        apiFetch("/api/v1/onboarding/user/complete", {
          method: "POST",
          credentials: "include",
        }).then((res) => readApiJson(res)),
        isAdminRole(role)
          ? client[":orgSlug"].api.v1.onboarding.complete
              .$post({ param: { orgSlug } })
              .then((res) => readApiJson(res))
          : null,
      ])
      setPreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: orgSlug,
      }))
      if (!(await refetchSessionOnboardingComplete()))
        throw new Error("The session does not show onboarding as complete")
    } catch {
      setCompleting(false)
      toast.error(FINISH_ERROR)
      return
    }
    void router.navigate({
      to: "/$orgSlug",
      params: { orgSlug },
      replace: true,
    })
  }

  const showDotNav =
    isJoinerLocked === true
      ? true
      : currentSlideName !== "welcome" || showWelcomeDotNav

  return (
    <OnboardingPageShell
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
      {currentSlideName === "welcome" ? (
        <OnboardingWelcomeSlide
          onWelcomeDetailsVisible={onWelcomeDetailsVisible}
          onGetStarted={() => goToSlide(1)}
        />
      ) : null}

      {currentSlideName === "how-it-works" ? (
        <OnboardingHowItWorksSlide
          actionLabel={isJoinerLocked ? "Get started" : "Next"}
          isPending={completing}
          onNext={() => {
            if (isJoinerLocked) {
              void finish()
              return
            }
            goToSlide(currentSlide + 1)
          }}
        />
      ) : null}

      {currentSlideName === "create-org" ? (
        <OnboardingCreateOrgSlide
          userEmail={user?.email}
          onOrgCreated={(slug) => {
            setCreatedOrgSlug(slug)
            void router.navigate({
              to: "/onboarding",
              search: (prev) => ({ ...prev, orgSlug: slug }),
              replace: true,
            })
            goToSlide(githubSlideIndexAdmin)
          }}
        />
      ) : null}

      {currentSlideName === "github" ? (
        <OnboardingGithubSlide
          orgSlug={orgSlug}
          finishing={completing}
          onFinish={() => void finish()}
        />
      ) : null}
    </OnboardingPageShell>
  )
}
