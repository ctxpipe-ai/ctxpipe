"use client"
import type { ModalOverlayProps } from "react-aria-components"
import {
  composeRenderProps,
  ModalOverlay,
  Modal as RACModal,
} from "react-aria-components"
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
  base: "font-sans w-full min-h-0 min-w-0 max-h-[calc(var(--visual-viewport-height)*.9)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-none bg-zinc-950/95 border border-zinc-800 text-zinc-100 forced-colors:bg-[Canvas] text-left align-middle shadow-2xl bg-clip-padding",
  variants: {
    size: {
      default: "max-w-[min(90vw,450px)]",
      wide: "max-w-[min(94vw,960px)]",
    },
    isEntering: {
      true: "animate-in zoom-in-105 ease-out duration-200",
    },
    isExiting: {
      true: "animate-out zoom-out-95 ease-in duration-200",
    },
  },
  defaultVariants: {
    size: "default",
  },
})

type ModalSize = "default" | "wide"

export function Modal(props: ModalOverlayProps & { size?: ModalSize }) {
  const { children, size = "default", className, ...overlayProps } = props
  return (
    <ModalOverlay {...overlayProps} className={overlayStyles}>
      <div className="sticky top-0 left-0 w-full h-(--visual-viewport-height) flex items-center justify-center box-border">
        <RACModal
          className={composeRenderProps(className, (userClassName, renderProps) =>
            modalStyles({ ...renderProps, size, className: userClassName }),
          )}
        >
          {children}
        </RACModal>
      </div>
    </ModalOverlay>
  )
}
