import {
  type RefObject,
  useCallback,
  useEffect,
  useSyncExternalStore,
} from "react"
import { Button } from "@/components/ui/Button"
import { useIsModalOpen } from "@/components/ui/Modal"
import { Popover } from "@/components/ui/Popover"
import { isWithinGuideWindow } from "@/features/home/setup-guide/guide-state"
import { useSession } from "@/lib/auth-client"
import { workspaceCreatedFlag } from "@/lib/session-flags"
import { sessionUser } from "@/lib/session-user"
import { useOrgGuide } from "@/lib/useOrgGuide"
import { activeHint, type HintId } from "./hint-state"

/** The hints whose anchor is on the page, so only one shows at a time. */
let mounted: HintId[] = []
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setMounted(next: HintId[]) {
  mounted = next
  for (const listener of listeners) listener()
}

const NO_HINTS: HintId[] = []

/**
 * A one-time popover on real UI, for users who finished onboarding in the
 * last 14 days. It does not show while a modal dialog is open, and it does
 * not take focus. Only "Got it" or Escape records the hint as seen; a blur,
 * a scroll or an outside click does not.
 */
export function OnboardingHint(props: {
  id: HintId
  orgSlug: string
  triggerRef: RefObject<Element | null>
  placement?: "right" | "bottom" | "bottom start" | "bottom end" | "left"
  children: string
}) {
  const { id } = props
  const { data: session } = useSession()
  const user = sessionUser(session)
  const [guide, updateGuide, loaded] = useOrgGuide(props.orgSlug)
  const modalOpen = useIsModalOpen()
  const onPage = useSyncExternalStore(
    subscribe,
    () => mounted,
    () => NO_HINTS,
  )

  // The anchor is on the page while this component is mounted.
  useEffect(() => {
    setMounted([...mounted, id])
    return () => setMounted(mounted.filter((item) => item !== id))
  }, [id])

  const open =
    loaded &&
    activeHint({
      mounted: onPage,
      seen: guide.hintsSeen ?? [],
      newUser: isWithinGuideWindow(user?.onboardingCompletedAt, Date.now()),
      modalOpen,
      createdWorkspace: workspaceCreatedFlag.isSet(),
    }) === id

  const markSeen = useCallback(
    () =>
      updateGuide((prev) => ({
        ...prev,
        hintsSeen: [...new Set([...(prev.hintsSeen ?? []), id])],
      })),
    [id, updateGuide],
  )

  // Escape works while focus stays on the page, outside the popover.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") markSeen()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open, markSeen])

  if (!open) return null
  return (
    <Popover
      triggerRef={props.triggerRef as RefObject<Element>}
      isOpen
      // A blur or a scroll asks to close. The hint stays until Got it.
      onOpenChange={() => {}}
      isNonModal
      showArrow
      placement={props.placement ?? "bottom"}
      className="w-64"
    >
      <div role="dialog" aria-label="Hint" className="p-3">
        <p className="text-sm text-zinc-200">{props.children}</p>
        <div className="mt-3 flex justify-end">
          <Button
            variant="secondary"
            className="h-7 px-2.5 text-xs"
            onPress={markSeen}
          >
            Got it
          </Button>
        </div>
      </div>
    </Popover>
  )
}
