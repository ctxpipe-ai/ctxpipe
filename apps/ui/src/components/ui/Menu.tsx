"use client"
import { IconCheck, IconChevronRight } from "@tabler/icons-react"
import React from "react"
import type { SeparatorProps } from "react-aria-components"
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  type MenuSectionProps as AriaMenuSectionProps,
  MenuTrigger as AriaMenuTrigger,
  type MenuTriggerProps as AriaMenuTriggerProps,
  Collection,
  composeRenderProps,
  Header,
  type MenuItemProps,
  type MenuProps,
  Separator,
} from "react-aria-components"
import { twMerge } from "tailwind-merge"

import { dropdownItemStylesDark } from "@/components/ui/ListBox"
import { Popover, type PopoverProps } from "@/components/ui/Popover"

/**
 * A list of commands, such as Rename or Delete, in a `MenuTrigger`. It is the
 * React Aria menu: use it, not the Base UI `DropdownMenu`, for a new menu. Use
 * a `Select` when the user chooses a value that the form keeps.
 */
export function Menu<T extends object>(props: MenuProps<T>) {
  return (
    <AriaMenu
      {...props}
      className={composeRenderProps(props.className, (className) =>
        twMerge(
          "font-sans p-0.5 outline outline-0 max-h-[inherit] overflow-auto rounded-md",
          className,
        ),
      )}
    />
  )
}

/**
 * One command of a `Menu`. It shows a check mark when the menu has a selection
 * mode, and a chevron when it opens a submenu.
 */
export function MenuItem(props: MenuItemProps) {
  const textValue =
    props.textValue ||
    (typeof props.children === "string" ? props.children : undefined)
  return (
    <AriaMenuItem
      textValue={textValue}
      {...props}
      className={composeRenderProps(props.className, (className, renderProps) =>
        dropdownItemStylesDark({ ...renderProps, className }),
      )}
    >
      {composeRenderProps(
        props.children,
        (children, { selectionMode, isSelected, hasSubmenu }) => (
          <>
            {selectionMode !== "none" && (
              <span className="flex items-center w-4">
                {isSelected && <IconCheck aria-hidden className="w-4 h-4" />}
              </span>
            )}
            <span className="flex items-center flex-1 gap-2 font-normal truncate group-selected:font-semibold">
              {children}
            </span>
            {hasSubmenu && (
              <IconChevronRight
                aria-hidden
                className="absolute w-4 h-4 right-2"
              />
            )}
          </>
        ),
      )}
    </AriaMenuItem>
  )
}

/**
 * A line between groups of items in a `Menu`, such as before a destructive
 * item.
 */
export function MenuSeparator(props: SeparatorProps) {
  return (
    <Separator
      {...props}
      className="mx-3 my-1 border-b border-neutral-300 dark:border-neutral-700"
    />
  )
}

/** Header of a `MenuSection`. A skeleton of a section uses it too. */
export const menuSectionHeaderClassName =
  "px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] text-zinc-500 bg-zinc-900/95 border-t border-zinc-800 first:border-t-0"

interface MenuSectionProps<T> extends AriaMenuSectionProps<T> {
  title?: string
  // oxlint-disable-next-line typescript/no-explicit-any -- the type is kept as is
  items?: any
  headerClassName?: string
}

/**
 * A group of items in a `Menu` with an optional title, such as the groups of
 * results in the command palette.
 */
export function MenuSection<T extends object>(props: MenuSectionProps<T>) {
  return (
    <AriaMenuSection {...props} className="py-0.5 first:pt-0 last:pb-0">
      {props.title && (
        <Header
          className={[menuSectionHeaderClassName, props.headerClassName]
            .filter(Boolean)
            .join(" ")}
        >
          {props.title}
        </Header>
      )}
      <Collection items={props.items}>{props.children}</Collection>
    </AriaMenuSection>
  )
}

interface MenuTriggerProps extends AriaMenuTriggerProps {
  placement?: PopoverProps["placement"]
  popoverClassName?: string
}

/**
 * Opens a `Menu` in a `Popover` from a button. Give it two children: the
 * trigger button first, then the `Menu`.
 */
export function MenuTrigger(props: MenuTriggerProps) {
  const { popoverClassName, ...rest } = props
  const [trigger, menu] = React.Children.toArray(props.children) as [
    React.ReactElement,
    React.ReactElement,
  ]
  return (
    <AriaMenuTrigger {...rest}>
      {trigger}
      <Popover
        placement={props.placement}
        className={["min-w-[150px]", popoverClassName]
          .filter(Boolean)
          .join(" ")}
      >
        {menu}
      </Popover>
    </AriaMenuTrigger>
  )
}
