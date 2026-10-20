import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SKELETON_DELAY_MS } from "@/components/ui/Skeleton"
import { chatDraftKey, writeChatDraft } from "@/features/chat/chat-draft"
import { activitySearch } from "@/features/home/activity-search"
import { HomeComposer } from "@/features/home/HomeComposer"
import { HomeNoticeToasts } from "@/features/home/HomeNotices"
import {
  ASK_PROMPT,
  SetupGuideCard,
  SetupGuideReveal,
} from "@/features/home/setup-guide/SetupGuide"
import { useSetupGuide } from "@/features/home/setup-guide/useSetupGuide"
import {
  ALL_WORKSPACES,
  WorkspaceActivity,
} from "@/features/home/WorkspaceActivity"
import { OrgOutletError } from "@/features/org/OrgOutletError"
import {
  landingWorkspace,
  workspaceListOptions,
} from "@/features/workspaces/queries"
import { WorkspaceCreateModal } from "@/features/workspaces/WorkspaceCreateModal"
import { useSession } from "@/lib/auth-client"
import { onboardingHandOffFlag, useSessionFlag } from "@/lib/session-flags"
import { useRevealOnce } from "@/lib/useRevealOnce"
import { useUserPreferences } from "@/lib/user-preferences"
import { useUrgentValue } from "@/lib/useUrgentValue"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/$orgSlug/")({
  validateSearch: activitySearch,
  errorComponent: ({ error, reset }) => (
    <OrgOutletError title="Could not load home" error={error} reset={reset} />
  ),
  component: OrgHomePage,
})

function OrgHomePage() {
  const { orgSlug } = Route.useParams()
  return <OrgHomePageContent orgSlug={orgSlug} />
}

/**
 * After onboarding, Home stays hidden until its first data is ready, then
 * fades in once, so nothing pops in. A slow or failed read does not keep
 * Home hidden: after `SKELETON_DELAY_MS` Home shows, with its skeletons or
 * its error.
 */
function useFirstDataReveal(hold: boolean, ready: boolean) {
  // `hold` can turn on after the first render (hydration reads it late), so
  // keep "data came" apart from "hold".
  const [done, setDone] = useState(false)
  if (!done && ready) setDone(true)
  useEffect(() => {
    if (!hold || done) return
    const timer = setTimeout(() => setDone(true), SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [hold, done])
  return !hold || done
}

/** Exported for Storybook — same dashboard as org home `/` under `/$orgSlug`. */
export function OrgHomePageContent({ orgSlug }: { orgSlug: string }) {
  const navigate = useNavigate()
  const [preferences, updatePreferences] = useUserPreferences()
  const { data: session, isPending: sessionPending } = useSession()
  const listQuery = useQuery(workspaceListOptions(orgSlug))
  const landing = listQuery.data ? landingWorkspace(listQuery.data) : null
  const [selectedId, setSelectedId] = useUrgentValue(
    landing?.id ?? null,
    orgSlug,
  )
  const selected =
    listQuery.data?.items.find((item) => item.id === selectedId) ?? landing
  const workspaces = listQuery.data?.items ?? []
  const guide = useSetupGuide(orgSlug)
  const [composerKey, setComposerKey] = useState(0)
  // Add Workspace from the guide. The dialog lives here, not in the guide:
  // the first Workspace moves the guide below the composer, and that
  // remounts the guide.
  const [createOpen, setCreateOpen] = useState(false)
  // Onboarding opened Home: hold it until its first data is ready (the
  // session, the Workspace list, and the guide signals), then fade it in.
  // The flag goes after the fade, so a reload does not hold Home again.
  const fromOnboarding = useSessionFlag(onboardingHandOffFlag)
  const revealed = useFirstDataReveal(fromOnboarding, guide.status === "ready")
  // After onboarding, Home fades in as a whole: the guide needs no transition.
  const guideShown = useRevealOnce(guide.status === "ready", fromOnboarding)
  useEffect(() => {
    if (fromOnboarding && revealed) onboardingHandOffFlag.clear()
  }, [fromOnboarding, revealed])

  useEffect(() => {
    if (preferences.selectedOrganizationSlug !== orgSlug) {
      updatePreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: orgSlug,
      }))
    }
  }, [orgSlug, preferences.selectedOrganizationSlug, updatePreferences])

  if (!sessionPending && !session) {
    return <Navigate to="/.auth/sign-in" replace />
  }

  // Named for the view transition that moves it when the notices come or go.
  const composer = (
    <div className="[view-transition-name:home-composer]">
      <HomeComposer
        orgSlug={orgSlug}
        workspaces={workspaces}
        selected={selected}
        onSelectWorkspace={setSelectedId}
        inputKey={composerKey}
      />
    </div>
  )
  // Ask: store the prompt as the draft of the current Workspace, then mount
  // a new text box, which reads that draft and takes focus.
  const ask = selected
    ? () => {
        writeChatDraft(chatDraftKey(orgSlug, selected.id), ASK_PROMPT)
        setComposerKey((key) => key + 1)
      }
    : undefined
  // Fix using agent (a hydrate problem toast): the same, in that Workspace.
  const fixWithAgent = (workspaceId: string, prompt: string) => {
    writeChatDraft(chatDraftKey(orgSlug, workspaceId), prompt)
    setSelectedId(workspaceId)
    setComposerKey((key) => key + 1)
  }
  const guideCard =
    guide.status === "ready" && guideShown ? (
      <SetupGuideReveal>
        <SetupGuideCard
          orgSlug={orgSlug}
          guide={guide}
          onAsk={ask}
          onCreateWorkspace={() => setCreateOpen(true)}
        />
      </SetupGuideReveal>
    ) : null
  const hasWorkspace = sessionPending || listQuery.isPending || selected
  // With no Workspace, the setup guide takes the composer's place. Without
  // the guide (the user dismissed it), keep the composer and the create button.
  const guideShows =
    guide.status === "ready" ? guide.view.kind !== "hidden" : guide.mayShow
  // A failed list read says nothing about the Workspaces. Do not show the
  // empty-organization body (setup guide, Create Workspace) in that case.
  const listFailed = listQuery.isError && !listQuery.data
  const body = listFailed ? (
    <InlineAlert
      variant="error"
      title="Could not load Workspaces"
      actions={
        <Button variant="secondary" onPress={() => void listQuery.refetch()}>
          Retry
        </Button>
      }
    >
      Try again in a moment.
    </InlineAlert>
  ) : hasWorkspace ? (
    <>
      <HomeNoticeToasts
        orgSlug={orgSlug}
        workspaces={workspaces}
        onFixWithAgent={fixWithAgent}
      />
      {composer}
      {guideCard}
    </>
  ) : guideShows ? (
    guideCard
  ) : (
    <>
      {composer}
      <Button
        variant="primary"
        onPress={() => {
          void navigate({
            to: "/$orgSlug/workspaces/new",
            params: { orgSlug },
          })
        }}
      >
        Create Workspace
      </Button>
    </>
  )

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col text-foreground">
      <div
        aria-busy={!revealed || undefined}
        className={cn(
          "mx-auto box-border w-full max-w-2xl p-8",
          fromOnboarding &&
            (revealed
              ? "animate-in fade-in duration-100 ease-out"
              : "invisible"),
        )}
      >
        <div className="space-y-10">
          {body}
          {/* With no Workspace, the activity of the organization shows, empty. */}
          {/* Activity and Recent keep the gap of the other Home blocks. */}
          <div className="space-y-10 pt-2 [view-transition-name:home-below]">
            <WorkspaceActivity
              orgSlug={orgSlug}
              workspaceSlug={
                sessionPending || listQuery.isPending
                  ? null
                  : (selected?.slug ?? ALL_WORKSPACES)
              }
              workspaces={workspaces}
            />
          </div>
        </div>
      </div>
      <WorkspaceCreateModal
        orgSlug={orgSlug}
        isOpen={createOpen}
        onOpenChange={setCreateOpen}
        onDone={() => setCreateOpen(false)}
      />
    </div>
  )
}
