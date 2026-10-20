import { useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { completeOnboarding } from "@/components/onboarding/complete-onboarding"
import { OnboardingCreateOrgSlide } from "@/components/onboarding/OnboardingCreateOrgSlide"
import { OnboardingHowItWorksSlide } from "@/components/onboarding/OnboardingHowItWorksSlide"
import { OnboardingPageShell } from "@/components/onboarding/OnboardingPageShell"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import { authClient, useListOrganizations, useSession } from "@/lib/auth-client"
import { onboardingHandOffFlag } from "@/lib/session-flags"
import { sessionUser } from "@/lib/session-user"

export const Route = createFileRoute("/onboarding")({
  ssr: false,
  component: OnboardingPageContent,
})

const FINISH_ERROR = "Could not finish onboarding. Try again."

/**
 * A user with no organization reads the welcome slide, then creates one. A
 * user who joined an organization reads the welcome slide only. Both then
 * open Home, where the Get started guide has the next steps (GitHub and the
 * first Workspace). Home fades in when its first data is ready.
 */
export function OnboardingPageContent() {
  const { data: session, isPending } = useSession()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: organizations, isPending: orgsPending } = useListOrganizations()
  const [step, setStep] = useState<"how-it-works" | "create-org">(
    "how-it-works",
  )

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
  // Onboarding is complete already, for example when the page mounts again
  // while `finish` runs, or when the user comes back through the browser
  // history. Open `/`. The hand-off flag that `finish` set still holds Home
  // for the fade.
  if (user?.onboardingCompletedAt && !completing && organizations?.length) {
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

  /**
   * Finish onboarding for both paths: make the org active, mark the user
   * (and, for an owner or admin, the org) complete, then open Home.
   */
  const finish = async (slug: string) => {
    if (completing) return
    setCompleting(true)
    // Before onboarding completes: Home reads the flag when it mounts, also
    // after this page mounts again and opens `/`. A failed call keeps the
    // flag, because the page that mounts again can still open Home. Home
    // clears the flag.
    onboardingHandOffFlag.set()
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
    // Home reads the flag and fades in when its first data is ready.
    void router.navigate({
      to: "/$orgSlug",
      params: { orgSlug: slug },
      replace: true,
    })
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
      {step === "how-it-works" ? (
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
