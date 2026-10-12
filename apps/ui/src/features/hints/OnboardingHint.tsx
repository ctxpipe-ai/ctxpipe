import { type RefObject, useEffect, useSyncExternalStore } from "react"
import { Dialog } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { Popover } from "@/components/ui/Popover"
import { isWithinGuideWindow } from "@/features/home/setup-guide/guide-state"
import { useSession } from "@/lib/auth-client"
import { useOrgGuide } from "@/lib/useOrgGuide"
import { activeHint, type HintId } from "./hint-state"

/**
 * The hints whose anchor is on the page, and the hints dismissed on this
 * page. Each hint has its own preference state, so a dismiss here tells the
 * other hints at once.
 */
const registry = {
  mounted: [] as HintId[],
  dismissed: [] as HintId[],
  listeners: new Set<() => void>(),
  emit() {
    for (const listener of registry.listeners) listener()
  },
  subscribe(listener: () => void) {
    registry.listeners.add(listener)
    return () => {
      registry.listeners.delete(listener)
    }
  },
  snapshot: { mounted: [] as HintId[], dismissed: [] as HintId[] },
  update() {
    registry.snapshot = {
      mounted: [...registry.mounted],
      dismissed: [...registry.dismissed],
    }
    registry.emit()
  },
}

const serverSnapshot = { mounted: [] as HintId[], dismissed: [] as HintId[] }

/**
 * A one-time popover on real UI, for users who finished onboarding in the
 * last 14 days. "Got it" or Escape records the hint as seen.
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
  const onboardingCompletedAt = (
    session?.user as { onboardingCompletedAt?: string | null } | undefined
  )?.onboardingCompletedAt
  const [guide, updateGuide, loaded] = useOrgGuide(props.orgSlug)
  const state = useSyncExternalStore(
    registry.subscribe,
    () => registry.snapshot,
    () => serverSnapshot,
  )

  // The anchor is on the page while this component is mounted.
  useEffect(() => {
    registry.mounted.push(id)
    registry.update()
    return () => {
      const index = registry.mounted.indexOf(id)
      if (index >= 0) registry.mounted.splice(index, 1)
      registry.update()
    }
  }, [id])

  const open =
    loaded &&
    activeHint({
      mounted: state.mounted,
      seen: [...(guide.hintsSeen ?? []), ...state.dismissed],
      newUser: isWithinGuideWindow(onboardingCompletedAt, Date.now()),
    }) === id

  const dismiss = () => {
    registry.dismissed.push(id)
    registry.update()
    updateGuide((prev) => ({
      ...prev,
      hintsSeen: [...new Set([...(prev.hintsSeen ?? []), id])],
    }))
  }

  if (!open) return null
  return (
    <Popover
      triggerRef={props.triggerRef as RefObject<Element>}
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen) dismiss()
      }}
      isNonModal
      showArrow
      placement={props.placement ?? "bottom"}
      className="w-64"
    >
      <Dialog aria-label="Hint" className="p-3 outline-0">
        <p className="text-sm text-zinc-200">{props.children}</p>
        <div className="mt-3 flex justify-end">
          <Button
            variant="secondary"
            className="h-7 px-2.5 text-xs"
            onPress={dismiss}
          >
            Got it
          </Button>
        </div>
      </Dialog>
    </Popover>
  )
}
