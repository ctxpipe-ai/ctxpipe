"use client"
import {
  Switch as AriaSwitch,
  type SwitchProps,
  composeRenderProps,
} from "react-aria-components"
import { tv } from "tailwind-variants"

import { focusRing } from "@/lib/react-aria-utils"

const switchStyles = tv({
  base: "group flex w-fit items-center gap-2.5 font-sans text-sm transition [-webkit-tap-highlight-color:transparent]",
  variants: {
    isDisabled: {
      false: "text-foreground",
      true: "cursor-default text-muted-foreground forced-colors:text-[GrayText]",
    },
  },
})

const trackStyles = tv({
  extend: focusRing,
  base: "flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
  variants: {
    isSelected: {
      false: "bg-white/15 group-pressed:bg-white/25",
      true: "bg-teal-500 group-pressed:bg-teal-600 forced-colors:bg-[Highlight]",
    },
    isDisabled: {
      true: "opacity-50",
    },
  },
})

const thumbStyles = tv({
  base: "size-3 rounded-full bg-white shadow transition-transform",
  variants: {
    isSelected: {
      true: "translate-x-3",
    },
  },
})

/** An on/off setting that applies at once, with its label on the right. */
export function Switch(props: SwitchProps) {
  return (
    <AriaSwitch
      {...props}
      className={composeRenderProps(props.className, (className, renderProps) =>
        switchStyles({ ...renderProps, className }),
      )}
    >
      {composeRenderProps(props.children, (children, renderProps) => (
        <>
          <span aria-hidden className={trackStyles(renderProps)}>
            <span className={thumbStyles(renderProps)} />
          </span>
          {children}
        </>
      ))}
    </AriaSwitch>
  )
}
