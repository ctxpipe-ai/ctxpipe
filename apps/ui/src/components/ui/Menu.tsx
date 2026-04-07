"use client"
import { IconCheck, IconChevronRight } from "@tabler/icons-react"
import React from "react"
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuProps,
  type MenuItemProps,
  MenuSection as AriaMenuSection,
  type MenuSectionProps as AriaMenuSectionProps,
  MenuTrigger as AriaMenuTrigger,
  SubmenuTrigger as AriaSubmenuTrigger,
  Separator,
  composeRenderProps,
  Header,
  Collection,
  type SubmenuTriggerProps,
  type MenuTriggerProps as AriaMenuTriggerProps,
} from "react-aria-components"
import type { SeparatorProps } from "react-aria-components"
import { dropdownItemStylesDark } from "@/components/ui/ListBox"
import { Popover, type PopoverProps } from "@/components/ui/Popover"

export function Menu<T extends object>(props: MenuProps<T>) {
  return (
    <AriaMenu
      {...props}
      className={composeRenderProps(props.className, (className) =>
        [
          "font-sans p-0.5 outline outline-0 max-h-[inherit] overflow-auto rounded-none",
          className,
        ]
          .filter(Boolean)
          .join(" "),
      )}
    />
  )
}

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

export function MenuSeparator(props: SeparatorProps) {
  return (
    <Separator
      {...props}
      className="mx-3 my-1 border-b border-neutral-300 dark:border-neutral-700"
    />
  )
}

export interface MenuSectionProps<T> extends AriaMenuSectionProps<T> {
  title?: string
  items?: any
  headerClassName?: string
}

export function MenuSection<T extends object>(props: MenuSectionProps<T>) {
  return (
    <AriaMenuSection
      {...props}
      className="py-0.5 first:pt-0 last:pb-0"
    >
      {props.title && (
        <Header
          className={[
            "px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 bg-zinc-900/95 border-t border-zinc-800 first:border-t-0",
            props.headerClassName,
          ]
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
        className={["min-w-[150px]", popoverClassName].filter(Boolean).join(" ")}
      >
        {menu}
      </Popover>
    </AriaMenuTrigger>
  )
}

export function SubmenuTrigger(props: SubmenuTriggerProps) {
  const [trigger, menu] = React.Children.toArray(props.children) as [
    React.ReactElement,
    React.ReactElement,
  ]
  return (
    <AriaSubmenuTrigger {...props}>
      {trigger}
      <Popover offset={-2} crossOffset={-4}>
        {menu}
      </Popover>
    </AriaSubmenuTrigger>
  )
}
