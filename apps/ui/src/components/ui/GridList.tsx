"use client"
import {
  GridList as AriaGridList,
  GridListItem as AriaGridListItem,
  Button,
  composeRenderProps,
  type GridListItemProps,
  type GridListProps,
} from "react-aria-components"
import { tv } from "tailwind-variants"
import { Checkbox } from "@/components/ui/Checkbox"
import { composeTailwindRenderProps, focusRing } from "@/lib/react-aria-utils"
import { twMerge } from "tailwind-merge"

export function GridList<T extends object>({
  children,
  ...props
}: GridListProps<T>) {
  return (
    <AriaGridList
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "overflow-auto relative bg-white dark:bg-zinc-900/60 border border-zinc-300 dark:border-zinc-700/60 font-sans empty:flex empty:items-center empty:justify-center empty:italic empty:text-sm",
      )}
    >
      {children}
    </AriaGridList>
  )
}

const itemStyles = tv({
  extend: focusRing,
  base: "relative flex gap-3 cursor-default select-none py-2 px-3 text-sm text-zinc-200 border-t border-t-zinc-700 border-transparent first:border-t-0 last:mb-0 -outline-offset-2",
  variants: {
    isSelected: {
      false: "hover:bg-zinc-700/60 pressed:bg-zinc-700/60",
      true: "bg-zinc-700/30 hover:bg-zinc-700/40 z-20",
    },
    isDisabled: {
      true: "text-zinc-300 dark:text-zinc-600 forced-colors:text-[GrayText] z-10",
    },
  },
})

export function GridListItem({
  children,
  className,
  ...props
}: GridListItemProps) {
  const textValue = typeof children === "string" ? children : undefined
  return (
    <AriaGridListItem
      textValue={textValue}
      {...props}
      className={composeRenderProps(className, (userClassName, renderProps) =>
        twMerge(itemStyles(renderProps), userClassName),
      )}
    >
      {composeRenderProps(
        children,
        (children, { selectionMode, selectionBehavior, allowsDragging }) => (
          <>
            {/* Add elements for drag and drop and selection. */}
            {allowsDragging && <Button slot="drag">≡</Button>}
            {selectionMode !== "none" && selectionBehavior === "toggle" && (
              <Checkbox slot="selection" />
            )}
            {children}
          </>
        ),
      )}
    </AriaGridListItem>
  )
}

