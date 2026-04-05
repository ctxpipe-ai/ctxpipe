"use client"
import { composeRenderProps, ModalOverlay, Modal as RACModal } from "react-aria-components"
import type { ModalOverlayProps } from "react-aria-components"
import { tv } from "tailwind-variants"

const overlayStyles = tv({
  base: "absolute top-0 left-0 w-full h-(--page-height) isolate z-20 bg-black/[45%] text-center backdrop-blur-sm",
  variants: {
    isEntering: {
      true: "animate-in fade-in duration-200 ease-out",
    },
    isExiting: {
      true: "animate-out fade-out duration-200 ease-in",
    },
  },
})

const modalStyles = tv({
  base: "font-sans w-full max-w-[min(90vw,450px)] max-h-[calc(var(--visual-viewport-height)*.9)] rounded-none bg-zinc-950/95 border border-zinc-800 text-zinc-100 forced-colors:bg-[Canvas] text-left align-middle shadow-2xl bg-clip-padding",
  variants: {
    isEntering: {
      true: "animate-in zoom-in-105 ease-out duration-200",
    },
    isExiting: {
      true: "animate-out zoom-out-95 ease-in duration-200",
    },
  },
})

export function Modal(props: ModalOverlayProps) {
  const { children, ...overlayProps } = props
  return (
    <ModalOverlay {...overlayProps} className={overlayStyles}>
      <div className="sticky top-0 left-0 w-full h-(--visual-viewport-height) flex items-center justify-center box-border">
        <RACModal
          className={composeRenderProps(undefined, (_, r) =>
            modalStyles(r),
          )}
        >
          {children}
        </RACModal>
      </div>
    </ModalOverlay>
  )
}
