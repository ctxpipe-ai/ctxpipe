"use client"
import { IconCheck } from "@tabler/icons-react"
import {
  ListBoxItem as AriaListBoxItem,
  composeRenderProps,
  type ListBoxItemProps,
} from "react-aria-components"
import { tv } from "tailwind-variants"

const dropdownItemStyles = tv({
  base: "group flex items-center gap-4 cursor-default select-none py-2 pl-3 pr-3 selected:pr-1 rounded-md outline outline-0 text-sm forced-color-adjust-none no-underline [&[href]]:cursor-pointer [-webkit-tap-highlight-color:transparent]",
  variants: {
    isDisabled: {
      false: "text-neutral-900 dark:text-neutral-100",
      true: "text-neutral-300 dark:text-neutral-600 forced-colors:text-[GrayText]",
    },
    isPressed: {
      true: "bg-neutral-100 dark:bg-neutral-800",
    },
    isFocused: {
      true: "bg-blue-600 dark:bg-blue-600 text-white forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]",
    },
    // React Aria's `isOpen` render prop: a menu item whose submenu is open. No classes of its own; the compound
    // variant below reads it, and tailwind-variants 4 only accepts keys that a variant declares.
    isOpen: {
      true: "",
    },
  },
  compoundVariants: [
    {
      isFocused: false,
      isOpen: true,
      className: "bg-neutral-100 dark:bg-neutral-700/60",
    },
  ],
})

export const dropdownItemStylesDark = tv({
  extend: dropdownItemStyles,
  base: "rounded-md !text-zinc-100 hover:bg-zinc-800",
  variants: {
    isSelected: {
      false: "!text-zinc-100",
      true: "bg-zinc-800 !text-zinc-100",
    },
    isDisabled: {
      false: "!text-zinc-100",
      true: "!text-zinc-500 forced-colors:text-[GrayText]",
    },
    isPressed: {
      true: "bg-zinc-800",
    },
    isFocused: {
      true: "!bg-zinc-800 !text-zinc-100 forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]",
    },
  },
  compoundVariants: [
    {
      isFocused: false,
      isOpen: true,
      className: "bg-zinc-800/60",
    },
  ],
})

/**
 * An option of a React Aria `ListBox`, with a check mark on the selected
 * option. `Select` uses it through `SelectItem`. Use `SelectItem` in a
 * `Select`, and `MenuItem` for a command in a `Menu`.
 */
export function DropdownItem(props: ListBoxItemProps) {
  const textValue =
    props.textValue ||
    (typeof props.children === "string" ? props.children : undefined)
  return (
    <AriaListBoxItem
      {...props}
      textValue={textValue}
      className={dropdownItemStyles}
    >
      {composeRenderProps(props.children, (children, { isSelected }) => (
        <>
          <span className="flex items-center flex-1 gap-2 font-normal truncate group-selected:font-semibold">
            {children}
          </span>
          <span className="flex items-center w-5">
            {isSelected && <IconCheck className="w-4 h-4" />}
          </span>
        </>
      ))}
    </AriaListBoxItem>
  )
}
