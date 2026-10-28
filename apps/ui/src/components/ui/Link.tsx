"use client"
import React from "react"
import {
  Link as AriaLink,
  type LinkProps as AriaLinkProps,
  composeRenderProps,
} from "react-aria-components"
import { tv } from "tailwind-variants"

import { focusRing } from "@/lib/react-aria-utils"

interface LinkProps extends AriaLinkProps {
  variant?: "primary" | "secondary"
}

const styles = tv({
  extend: focusRing,
  base: "underline disabled:no-underline disabled:cursor-default forced-colors:disabled:text-[GrayText] transition rounded-xs [-webkit-tap-highlight-color:transparent]",
  variants: {
    variant: {
      // Teal is the one link accent (DESIGN.md). No blue.
      primary:
        "text-teal-700 dark:text-teal-400 underline decoration-teal-700/60 hover:decoration-teal-700 dark:decoration-teal-400/50 dark:hover:text-teal-300 dark:hover:decoration-teal-300",
      secondary:
        "text-neutral-700 dark:text-neutral-300 underline decoration-neutral-700/50 hover:decoration-neutral-700 dark:decoration-neutral-300/70 dark:hover:decoration-neutral-300",
    },
  },
  defaultVariants: {
    variant: "primary",
  },
})

export function Link(props: LinkProps) {
  return (
    <AriaLink
      {...props}
      className={composeRenderProps(props.className, (className, renderProps) =>
        styles({ ...renderProps, className, variant: props.variant }),
      )}
    />
  )
}
