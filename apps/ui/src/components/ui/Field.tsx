"use client"
import {
  Group,
  FieldError as RACFieldError,
  Input as RACInput,
  Label as RACLabel,
  Text,
  composeRenderProps,
} from "react-aria-components"
import type {
  FieldErrorProps,
  GroupProps,
  InputProps,
  LabelProps,
  TextProps,
} from "react-aria-components"
import { twMerge } from "tailwind-merge"
import { tv } from "tailwind-variants"

import { composeTailwindRenderProps, focusRing } from "@/lib/react-aria-utils"

/**
 * The label of a form field, in medium muted text. The house fields
 * (`TextField`, `SearchField`, `Select`) add it from their `label` prop; use it
 * alone only in a field that you compose from React Aria parts.
 */
export function Label(props: LabelProps) {
  return (
    <RACLabel
      {...props}
      className={twMerge(
        "font-sans text-sm text-neutral-600 dark:text-neutral-300 font-medium cursor-default w-fit",
        props.className,
      )}
    />
  )
}

/**
 * The help text below a form field, in muted text. It is in the `description`
 * slot, so a screen reader reads it with the field. The house fields add it
 * from their `description` prop.
 */
export function Description(props: TextProps) {
  return (
    <Text
      {...props}
      slot="description"
      className={twMerge(
        "text-sm text-neutral-600 dark:text-neutral-400",
        props.className,
      )}
    />
  )
}

/**
 * The error message of a form field, in red. It shows only while the field is
 * invalid. The house fields add it from their `errorMessage` prop.
 */
export function FieldError(props: FieldErrorProps) {
  return (
    <RACFieldError
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "text-sm text-red-600 forced-colors:text-[Mark]",
      )}
    />
  )
}

export const fieldBorderStyles = tv({
  base: "transition",
  variants: {
    isFocusWithin: {
      false:
        "border-neutral-300 hover:border-neutral-400 dark:border-neutral-600 dark:hover:border-neutral-500 forced-colors:border-[ButtonBorder]",
      true: "border-neutral-600 dark:border-neutral-300 forced-colors:border-[Highlight]",
    },
    isInvalid: {
      true: "border-red-600 dark:border-red-600 forced-colors:border-[Mark]",
    },
    isDisabled: {
      true: "border-neutral-200 dark:border-neutral-700 forced-colors:border-[GrayText]",
    },
  },
})

const fieldGroupStyles = tv({
  extend: focusRing,
  base: "group flex items-center h-9 box-border bg-white dark:bg-neutral-900 forced-colors:bg-[Field] border rounded-md overflow-hidden transition",
  variants: fieldBorderStyles.variants,
})

/**
 * The bordered box of a field that holds an `Input` with icons or buttons, such
 * as the search icon and the clear button of `SearchField`. Its border shows
 * the focus, invalid and disabled states.
 */
export function FieldGroup(props: GroupProps) {
  return (
    <Group
      {...props}
      className={composeRenderProps(props.className, (className, renderProps) =>
        fieldGroupStyles({ ...renderProps, className }),
      )}
    />
  )
}

/**
 * The text input of a field, with no border of its own. Put it in a React Aria
 * field, in a `FieldGroup` or in a box with a border. Use `TextField` for a
 * complete text field with a label.
 */
export function Input(props: InputProps) {
  return (
    <RACInput
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "px-3 py-0 min-h-9 flex-1 min-w-0 border-0 outline outline-0 bg-white dark:bg-neutral-900 font-sans text-sm text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-600 dark:placeholder:text-neutral-400 disabled:text-neutral-200 dark:disabled:text-neutral-600 disabled:placeholder:text-neutral-200 dark:disabled:placeholder:text-neutral-600 [-webkit-tap-highlight-color:transparent]",
      )}
    />
  )
}
