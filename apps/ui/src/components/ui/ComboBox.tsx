"use client"
import { IconChevronDown } from "@tabler/icons-react"
import type React from "react"
import type {
  ComboBoxProps as AriaComboBoxProps,
  ListBoxItemProps,
  ValidationResult,
} from "react-aria-components"
import { ComboBox as AriaComboBox, ListBox } from "react-aria-components"

import {
  Description,
  FieldError,
  FieldGroup,
  Input,
  Label,
} from "@/components/ui/Field"
import { FieldButton } from "@/components/ui/FieldButton"
import { DropdownItem } from "@/components/ui/ListBox"
import { Popover } from "@/components/ui/Popover"
import { composeTailwindRenderProps } from "@/lib/react-aria-utils"

interface ComboBoxProps<T extends object> extends Omit<
  AriaComboBoxProps<T>,
  "children"
> {
  label?: string
  description?: string
  errorMessage?: string | ((validation: ValidationResult) => string)
  placeholder?: string
  /** The text of the list when no option matches the typed text. */
  emptyText?: string
  /** Classes of the label, for example a smaller label in a toolbar. */
  labelClassName?: string
  /** Classes of the text input, for example `font-mono` for branch names. */
  inputClassName?: string
  items?: Iterable<T>
  children: React.ReactNode | ((item: T) => React.ReactNode)
}

/**
 * A field where the user types to filter a long list and picks one value,
 * such as a branch of a repository. Put a `ComboBoxItem` in it for each
 * option. Use `Select` for a short list that needs no filter, and
 * `SearchField` to filter a list that is on the page.
 */
export function ComboBox<T extends object>({
  label,
  description,
  errorMessage,
  placeholder,
  emptyText = "No option matches",
  labelClassName,
  inputClassName,
  children,
  items,
  ...props
}: ComboBoxProps<T>) {
  return (
    <AriaComboBox
      // The list stays open with its empty text when no option matches.
      allowsEmptyCollection
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "group flex flex-col gap-1 font-sans",
      )}
    >
      {label && <Label className={labelClassName}>{label}</Label>}
      <FieldGroup className="h-8 min-w-0">
        <Input
          placeholder={placeholder}
          className={composeTailwindRenderProps(inputClassName, "min-h-8 pr-1")}
        />
        <FieldButton className="mr-1 w-6">
          <IconChevronDown aria-hidden className="size-4" />
        </FieldButton>
      </FieldGroup>
      {description && <Description>{description}</Description>}
      <FieldError>{errorMessage}</FieldError>
      <Popover className="min-w-(--trigger-width)">
        <ListBox
          items={items}
          renderEmptyState={() => (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {emptyText}
            </p>
          )}
          className="outline-hidden box-border max-h-64 overflow-auto p-1"
        >
          {children}
        </ListBox>
      </Popover>
    </AriaComboBox>
  )
}

/** One option of a `ComboBox`, with a check mark when it is selected. */
export function ComboBoxItem(props: ListBoxItemProps) {
  return <DropdownItem dark {...props} />
}
