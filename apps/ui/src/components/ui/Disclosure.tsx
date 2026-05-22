"use client"
import { IconChevronRight } from "@tabler/icons-react"
import type React from "react"
import { useContext } from "react"
import type {
  DisclosurePanelProps as AriaDisclosurePanelProps,
  DisclosureProps as AriaDisclosureProps,
} from "react-aria-components"
import {
  Disclosure as AriaDisclosure,
  DisclosurePanel as AriaDisclosurePanel,
  composeRenderProps,
  DisclosureStateContext,
  Heading,
} from "react-aria-components"
import { tv } from "tailwind-variants"
import { Button } from "@/components/ui/Button"
import { composeTailwindRenderProps } from "@/lib/react-aria-utils"

const disclosure = tv({
  base: "group min-w-50 font-sans rounded-none text-foreground",
})

const chevron = tv({
  base: "w-4 h-4 text-muted-foreground transition-transform duration-200 ease-in-out",
  variants: {
    isExpanded: {
      true: "transform rotate-90",
    },
    isDisabled: {
      true: "text-muted-foreground/50 forced-colors:text-[GrayText]",
    },
  },
})

export interface DisclosureProps extends AriaDisclosureProps {
  children: React.ReactNode
}

export function Disclosure({ children, ...props }: DisclosureProps) {
  return (
    <AriaDisclosure
      {...props}
      className={composeRenderProps(props.className, (className, renderProps) =>
        disclosure({ ...renderProps, className }),
      )}
    >
      {children}
    </AriaDisclosure>
  )
}

export interface DisclosureHeaderProps {
  children: React.ReactNode
  /**
   * When set, show this label on the right instead of the expand chevron. The main
   * `children` remain the control’s accessible name.
   */
  trailingPill?: string
}

export function DisclosureHeader({
  children,
  trailingPill,
}: DisclosureHeaderProps) {
  const state = useContext(DisclosureStateContext)
  if (!state) {
    return null
  }
  const { isExpanded } = state
  return (
    <Heading className="m-0 text-sm font-medium text-foreground">
      <Button
        slot="trigger"
        variant="ghost"
        className="group flex h-auto min-h-0 w-full items-center justify-between gap-2 rounded-none px-2 py-1.5 text-left text-sm font-medium text-inherit"
      >
        {({ isDisabled }) => (
          <>
            <span className="min-w-0 flex-1">{children}</span>
            {trailingPill != null && trailingPill !== "" ? (
              <span
                aria-hidden
                className="shrink-0 rounded-none border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground transition group-hover:bg-foreground/[0.06] group-hover:text-foreground"
              >
                {trailingPill}
              </span>
            ) : (
              <IconChevronRight
                aria-hidden
                className={`${chevron({ isExpanded, isDisabled })} shrink-0`}
              />
            )}
          </>
        )}
      </Button>
    </Heading>
  )
}

export interface DisclosurePanelProps extends AriaDisclosurePanelProps {
  children: React.ReactNode
}

export function DisclosurePanel({ children, ...props }: DisclosurePanelProps) {
  return (
    <AriaDisclosurePanel
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "h-(--disclosure-panel-height) motion-safe:transition-[height] overflow-clip",
      )}
    >
      <div className="px-0 pt-0.5 pb-0">{children}</div>
    </AriaDisclosurePanel>
  )
}
