"use client"
import {
  OverlayArrow,
  Popover as AriaPopover,
  type PopoverProps as AriaPopoverProps,
  composeRenderProps,
} from "react-aria-components"
import React from "react"
import { tv } from "tailwind-variants"

export interface PopoverProps extends Omit<AriaPopoverProps, "children"> {
  showArrow?: boolean
  children: React.ReactNode
}

const styles = tv({
  base: "font-sans rounded-md bg-zinc-900 border border-zinc-800 text-zinc-100 forced-colors:bg-[Canvas] shadow-2xl bg-clip-padding outline-0",
  variants: {
    isEntering: {
      true: "animate-in fade-in placement-bottom:slide-in-from-top-1 placement-top:slide-in-from-bottom-1 placement-left:slide-in-from-right-1 placement-right:slide-in-from-left-1 ease-out duration-200",
    },
    isExiting: {
      true: "animate-out fade-out placement-bottom:slide-out-to-top-1 placement-top:slide-out-to-bottom-1 placement-left:slide-out-to-right-1 placement-right:slide-out-to-left-1 ease-in duration-150",
    },
  },
})

export function Popover({
  children,
  showArrow,
  className,
  ...props
}: PopoverProps) {
  const offset = showArrow ? 12 : 8
  return (
    <AriaPopover
      offset={offset}
      {...props}
      className={composeRenderProps(className, (cls, renderProps) =>
        styles({ ...renderProps, className: cls }),
      )}
    >
      {showArrow && (
        <OverlayArrow className="group">
          <svg
            width={12}
            height={12}
            viewBox="0 0 12 12"
            className="block fill-zinc-900 forced-colors:fill-[Canvas] stroke-1 stroke-zinc-800 forced-colors:stroke-[ButtonBorder] group-placement-bottom:rotate-180 group-placement-left:-rotate-90 group-placement-right:rotate-90"
          >
            <path d="M0 0 L6 6 L12 0" />
          </svg>
        </OverlayArrow>
      )}
      {children}
    </AriaPopover>
  )
}
