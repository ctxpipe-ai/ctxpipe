"use client"
import {
  GridList as AriaGridList,
  GridListItem as AriaGridListItem,
  GridListHeader as AriaGridListHeader,
  GridListLoadMoreItem as AriaGridListLoadMoreItem,
  Button,
  composeRenderProps,
  type GridListItemProps,
  type GridListLoadMoreItemProps,
  type GridListProps,
} from "react-aria-components"
import type { HTMLAttributes } from "react"
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
        "overflow-auto w-[200px] relative bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 font-sans empty:flex empty:items-center empty:justify-center empty:italic empty:text-sm",
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

export function GridListHeader({
  children,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <AriaGridListHeader
      {...props}
      className={twMerge(
        "text-sm font-semibold text-zinc-500 dark:text-zinc-300 px-4 py-1 -mt-px z-10 bg-zinc-100/60 dark:bg-zinc-700/60 backdrop-blur-md supports-[-moz-appearance:none]:bg-zinc-100 border-y border-y-zinc-200 dark:border-y-zinc-700",
        props.className,
      )}
    >
      {children}
    </AriaGridListHeader>
  )
}

export function GridListLoadMoreItem({
  children = "Show more",
  className,
  ...props
}: GridListLoadMoreItemProps) {
  return (
    <AriaGridListLoadMoreItem
      {...props}
      className={twMerge(
        "relative flex cursor-default select-none py-2 px-3 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60 border-t border-t-zinc-700 -outline-offset-2",
        className,
      )}
    >
      {children}
    </AriaGridListLoadMoreItem>
  )
}
