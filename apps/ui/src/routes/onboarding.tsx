import { useQueryClient } from "@tanstack/react-query"
import {
  createFileRoute,
  Navigate,
  useRouter,
  useSearch,
} from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { completeOnboarding } from "@/components/onboarding/complete-onboarding"
import { OnboardingConnectGithubSlide } from "@/components/onboarding/OnboardingConnectGithubSlide"
import { OnboardingCreateOrgSlide } from "@/components/onboarding/OnboardingCreateOrgSlide"
import { OnboardingHowItWorksSlide } from "@/components/onboarding/OnboardingHowItWorksSlide"
import { OnboardingPageShell } from "@/components/onboarding/OnboardingPageShell"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import { authClient, useListOrganizations, useSession } from "@/lib/auth-client"
import { sessionUser } from "@/lib/session-user"

export const Route = createFileRoute("/onboarding")({
  ssr: false,
  // `github`: the slug of the organization that the user created. The
  // Connect GitHub slide shows after onboarding is complete, so it lives in
  // the URL and not in component state.
  validateSearch: (search: Record<string, unknown>): { github?: string } =>
    typeof search.github === "string" ? { github: search.github } : {},
  component: OnboardingPageContent,
})

const FINISH_ERROR = "Could not finish onboarding. Try again."

/**
 * A user with no organization reads How ctx| works, creates one, then can
 * connect GitHub or skip it. A user who joined an organization reads How
 * ctx| works only. Both then open Home, where the Get started guide has the
 * next steps (the first Workspace, and GitHub if the user skipped it).
 */
export function OnboardingPageContent() {
  const { data: session, isPending } = useSession()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: organizations, isPending: orgsPending } = useListOrganizations()
  const [step, setStep] = useState<"how-it-works" | "create-org">(
    "how-it-works",
  )
  const { github: githubParam } = useSearch({ strict: false })

  const [isJoinerLocked, setIsJoinerLocked] = useState<boolean | null>(null)
  const [sceneFailed, setSceneFailed] = useState(false)
  const [sceneReady, setSceneReady] = useState(false)
  const [completing, setCompleting] = useState(false)

  useEffect(() => {
    if (sceneReady || sceneFailed) return
    const timer = window.setTimeout(() => {
      setSceneReady(true)
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [sceneReady, sceneFailed])

  // Fixed on arrival: the organization that a user creates here must not
  // make the user a joiner.
  useEffect(() => {
    if (orgsPending || organizations == null) return
    setIsJoinerLocked((prev) => {
      if (prev !== null) return prev
      return organizations.length > 0
    })
  }, [organizations, orgsPending])

  // Signed out (e.g. an expired verification link landed here): the
  // organization data below never arrives, so do not wait for it.
  if (!isPending && !session) return <Navigate to="/.auth/sign-in" replace />
  if (isPending || orgsPending || isJoinerLocked === null) {
    return (
      <OnboardingPageShell
        sceneReady={false}
        sceneFailed={false}
        onSceneLoad={() => {}}
        onSceneError={() => {}}
      >
        <div className="mx-auto max-w-2xl">
          <PageBodySkeleton label="Preparing onboarding" />
        </div>
      </OnboardingPageShell>
    )
  }
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const user = sessionUser(session)
  // The Connect GitHub slide shows only after onboarding is complete, so a
  // GitHub flow that leaves the page cannot send the user back here.
  const githubSlug = user?.onboardingCompletedAt ? githubParam : undefined
  // Onboarding is complete already, for example when the user comes back
  // through the browser history. While `finish` runs, it opens Home or the
  // GitHub slide itself.
  if (
    user?.onboardingCompletedAt &&
    !completing &&
    organizations?.length &&
    !githubSlug
  ) {
    return (
      <Navigate
        to="/"
        search={{
          error: undefined,
          error_description: undefined,
          pendingAccountClaim: undefined,
        }}
        replace
      />
    )
  }

  const openHome = (slug: string) => {
    void router.navigate({
      to: "/$orgSlug",
      params: { orgSlug: slug },
      replace: true,
    })
  }

  /**
   * Finish onboarding for both paths: make the org active, and mark the user
   * (and, for an owner or admin, the org) complete. Then a joiner opens Home,
   * and the creator of the organization gets the GitHub slide.
   */
  const finish = async (slug: string) => {
    if (completing) return
    setCompleting(true)
    // Put the GitHub step in the URL first. The session changes when
    // onboarding completes, and a page that mounts again then must show the
    // GitHub slide, not open Home.
    if (!isJoinerLocked) {
      await router.navigate({
        to: "/onboarding",
        search: { github: slug },
        replace: true,
      })
    }
    const organization = organizations?.find((org) => org.slug === slug)
    try {
      // The request that creates an organization also makes it active.
      if (organization) {
        await authClient.organization.setActive({
          organizationId: organization.id,
          fetchOptions: { throw: true },
        })
      }
      await completeOnboarding(slug, queryClient)
    } catch {
      setCompleting(false)
      toast.error(FINISH_ERROR)
      return
    }
    if (isJoinerLocked) openHome(slug)
  }

  const joinedSlug = organizations?.[0]?.slug

  return (
    <OnboardingPageShell
      sceneReady={sceneReady}
      sceneFailed={sceneFailed}
      onSceneLoad={() => {
        setSceneReady(true)
        setSceneFailed(false)
      }}
      onSceneError={() => {
        setSceneReady(true)
        setSceneFailed(true)
      }}
    >
      {githubSlug ? (
        <OnboardingConnectGithubSlide
          orgSlug={githubSlug}
          onDone={() => openHome(githubSlug)}
        />
      ) : step === "how-it-works" ? (
        <OnboardingHowItWorksSlide
          actionLabel={isJoinerLocked ? "Get started" : "Next"}
          isPending={completing}
          onNext={() => {
            if (!isJoinerLocked) {
              setStep("create-org")
              return
            }
            if (joinedSlug) void finish(joinedSlug)
          }}
        />
      ) : (
        <OnboardingCreateOrgSlide
          userEmail={user?.email}
          finishing={completing}
          onFinish={(slug) => void finish(slug)}
        />
      )}
    </OnboardingPageShell>
  )
}
