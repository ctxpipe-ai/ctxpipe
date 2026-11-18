"use client"
import React from "react"
import { type FormProps, Form as RACForm } from "react-aria-components"
import { twMerge } from "tailwind-merge"

/**
 * A React Aria form that puts its fields in a column with a gap between them.
 * Use it around the fields that the user submits together, so that React Aria
 * validates them on submit.
 */
export function Form(props: FormProps) {
  return (
    <RACForm
      {...props}
      className={twMerge("flex flex-col gap-6", props.className)}
    />
  )
}
