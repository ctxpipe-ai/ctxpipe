"use client"
import type React from "react"
import type {
  TextFieldProps as AriaTextFieldProps,
  ValidationResult,
} from "react-aria-components"
import { TextField as AriaTextField, TextArea } from "react-aria-components"
import { tv } from "tailwind-variants"
import {
  Description,
  FieldError,
  fieldBorderStyles,
  Input,
  Label,
} from "@/components/ui/Field"
import { composeTailwindRenderProps, focusRing } from "@/lib/react-aria-utils"

const inputStyles = tv({
  extend: focusRing,
  base: "border-1 rounded-md min-h-9 font-sans text-sm py-0 px-3 box-border transition",
  variants: {
    isFocused: fieldBorderStyles.variants.isFocusWithin,
    isInvalid: fieldBorderStyles.variants.isInvalid,
    isDisabled: fieldBorderStyles.variants.isDisabled,
  },
})

export interface TextFieldProps extends AriaTextFieldProps {
  label?: string
  description?: React.ReactNode
  placeholder?: string
  errorMessage?: string | ((validation: ValidationResult) => string)
  /** Render a text area with this many rows instead of a one-line input. */
  rows?: number
}

export function TextField({
  label,
  description,
  errorMessage,
  rows,
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "flex flex-col gap-1 font-sans",
      )}
    >
      {label && <Label>{label}</Label>}
      {rows ? (
        <TextArea
          rows={rows}
          className={(renderProps) =>
            inputStyles({
              ...renderProps,
              className:
                "bg-white py-2 font-mono text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200",
            })
          }
        />
      ) : (
        <Input className={inputStyles} />
      )}
      {description && <Description>{description}</Description>}
      <FieldError>{errorMessage}</FieldError>
    </AriaTextField>
  )
}
