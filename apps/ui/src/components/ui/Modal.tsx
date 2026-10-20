"use client"
import { useEffect, useSyncExternalStore } from "react"
import type { ModalOverlayProps } from "react-aria-components"
import {
  composeRenderProps,
  ModalOverlay,
  Modal as RACModal,
} from "react-aria-components"
import { tv } from "tailwind-variants"

/*
 * `duration-100` also sets `transition-duration`, and the initial
 * `transition-property` is `all`. A new page height or content height during
 * the exit then makes a height transition, and the next change cancels it.
 * React Aria waits for every animation of the overlay and the modal, ignores
 * the cancel, and so never removes the modal. `transition-none` stops this.
 */
const overlayStyles = tv({
  base: "transition-none absolute top-0 left-0 w-full h-(--page-height) isolate z-20 bg-black/[45%] text-center backdrop-blur-sm",
  variants: {
    isEntering: {
      true: "animate-in fade-in duration-100 ease-out",
    },
    isExiting: {
      true: "animate-out fade-out duration-100 ease-in",
    },
  },
})

const modalStyles = tv({
  base: "transition-none font-sans w-full min-h-0 min-w-0 max-h-[calc(var(--visual-viewport-height)*.9)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-md bg-zinc-950/95 border border-zinc-800 text-zinc-100 forced-colors:bg-[Canvas] text-left align-middle shadow-2xl bg-clip-padding",
  variants: {
    size: {
      default: "max-w-[min(90vw,450px)]",
      medium: "max-w-[min(92vw,36rem)]",
      wide: "max-w-[min(94vw,960px)]",
    },
    isEntering: {
      true: "animate-in zoom-in-105 ease-out duration-100",
    },
    isExiting: {
      true: "animate-out zoom-out-95 ease-in duration-100",
    },
  },
  defaultVariants: {
    size: "default",
  },
})

/** How many modals are on the page. Every modal dialog uses this Modal. */
let openModals = 0
const openModalListeners = new Set<() => void>()

function subscribeOpenModals(listener: () => void) {
  openModalListeners.add(listener)
  return () => {
    openModalListeners.delete(listener)
  }
}

function addOpenModals(change: number) {
  openModals += change
  for (const listener of openModalListeners) listener()
}

/** Counts this modal while it is on the page (also while it fades out). */
function OpenModalMarker() {
  useEffect(() => {
    addOpenModals(1)
    return () => addOpenModals(-1)
  }, [])
  return null
}

/** True while a modal dialog is on the page. */
export function useIsModalOpen() {
  return useSyncExternalStore(
    subscribeOpenModals,
    () => openModals > 0,
    () => false,
  )
}

type ModalSize = "default" | "medium" | "wide"
type ModalPlacement = "center" | "top"

const frameStyles = tv({
  base: "sticky top-0 left-0 box-border flex h-(--visual-viewport-height) w-full justify-center",
  variants: {
    placement: {
      center: "items-center",
      top: "items-start pt-16",
    },
  },
  defaultVariants: {
    placement: "center",
  },
})

export function Modal(
  props: ModalOverlayProps & { size?: ModalSize; placement?: ModalPlacement },
) {
  const {
    children,
    size = "default",
    placement = "center",
    className,
    ...overlayProps
  } = props
  return (
    <ModalOverlay {...overlayProps} className={overlayStyles}>
      <OpenModalMarker />
      <div className={frameStyles({ placement })}>
        <RACModal
          className={composeRenderProps(
            className,
            (userClassName, renderProps) =>
              modalStyles({ ...renderProps, size, className: userClassName }),
          )}
        >
          {children}
        </RACModal>
      </div>
    </ModalOverlay>
  )
}
